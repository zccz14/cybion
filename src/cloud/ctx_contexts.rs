use super::*;

#[derive(Debug, Deserialize)]
struct CtxDocument {
    id: String,
    title: String,
    kind: String,
    parent_id: Option<String>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Deserialize)]
struct CtxDocumentDetail {
    document: CtxDocument,
    revision: CtxRevision,
}

#[derive(Debug, Deserialize)]
struct CtxRevision {
    content: String,
}

#[derive(Debug, Deserialize)]
struct CtxCreatedKey {
    id: String,
    secret: String,
}

#[derive(Debug, Serialize)]
pub(super) struct CtxStatusView {
    pub(super) connected: bool,
    pub(super) key_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct CtxDisconnectView {
    pub(super) connected: bool,
    pub(super) revoked: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct CtxDocumentsView {
    pub(super) connected: bool,
    pub(super) documents: Vec<ContextSummary>,
    pub(super) notice: Option<String>,
}

pub(super) enum ReadOutcome {
    Found(ContextReadView),
    NotConnected,
    NotFound,
    Unavailable(String),
}

pub(super) async fn status(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<CtxStatusView>, ApiError> {
    Ok(Json(status_for(&state, &identity.user).await?))
}

pub(super) async fn connect(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<CtxStatusView>, ApiError> {
    Ok(Json(
        connect_for(&state, &identity.user, &identity.bearer).await?,
    ))
}

pub(super) async fn disconnect(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<CtxDisconnectView>, ApiError> {
    Ok(Json(
        disconnect_for(&state, &identity.user, &identity.bearer).await?,
    ))
}

pub(super) async fn documents(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<CtxDocumentsView>, ApiError> {
    Ok(Json(documents_for(&state, &identity.user).await?))
}

pub(super) async fn status_for(state: &AppState, user: &User) -> Result<CtxStatusView, ApiError> {
    let settings = read_settings(state, user).await?;
    Ok(CtxStatusView {
        connected: !settings.ctx_api_key.is_empty(),
        key_id: (!settings.ctx_api_key_id.is_empty()).then(|| settings.ctx_api_key_id.clone()),
    })
}

pub(super) async fn connect_for(
    state: &AppState,
    user: &User,
    bearer: &str,
) -> Result<CtxStatusView, ApiError> {
    let settings = read_settings(state, user).await?;
    if !settings.ctx_api_key_id.is_empty() {
        // RECOVERY: replacing a connection is best effort; a stale key is still
        // revocable from CTX by hand, so a failed revoke must not block Connect.
        let _ = revoke_key(state, bearer, &settings.ctx_api_key_id).await;
    }
    let created = create_key(state, bearer, INTEGRATION_NAME).await?;
    let key_id = created.id;
    let secret = created.secret;
    let stored_key_id = key_id.clone();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO integration_settings(id,ctx_api_key,ctx_api_key_id,updated_at) VALUES(1,?,?,?)
             ON CONFLICT(id) DO UPDATE SET ctx_api_key=excluded.ctx_api_key,ctx_api_key_id=excluded.ctx_api_key_id,updated_at=excluded.updated_at",
            params![secret, key_id, now()],
        )?;
        Ok(())
    })
    .await?;
    Ok(CtxStatusView {
        connected: true,
        key_id: Some(stored_key_id),
    })
}

pub(super) async fn disconnect_for(
    state: &AppState,
    user: &User,
    bearer: &str,
) -> Result<CtxDisconnectView, ApiError> {
    let settings = read_settings(state, user).await?;
    let revoked = if settings.ctx_api_key_id.is_empty() {
        false
    } else {
        revoke_key(state, bearer, &settings.ctx_api_key_id)
            .await
            .is_ok()
    };
    user_db(state, user, true, |connection| {
        connection.execute(
            "INSERT INTO integration_settings(id,ctx_api_key,ctx_api_key_id,updated_at) VALUES(1,'','',?)
             ON CONFLICT(id) DO UPDATE SET ctx_api_key='',ctx_api_key_id='',updated_at=excluded.updated_at",
            params![now()],
        )?;
        Ok(())
    })
    .await?;
    Ok(CtxDisconnectView {
        connected: false,
        revoked,
    })
}

pub(super) async fn documents_for(
    state: &AppState,
    user: &User,
) -> Result<CtxDocumentsView, ApiError> {
    let settings = read_settings(state, user).await?;
    let (documents, notice) = match connected_key(&settings) {
        Some(key) => match list_documents(state, &key).await {
            Ok(documents) => (top_level_summaries_of(&documents), None),
            Err(error) => (Vec::new(), Some(error.message)),
        },
        None => (Vec::new(), None),
    };
    Ok(CtxDocumentsView {
        connected: !settings.ctx_api_key.is_empty(),
        documents,
        notice,
    })
}

pub(super) async fn top_level_summaries(
    state: &AppState,
    user: &User,
) -> (Vec<ContextSummary>, Option<String>) {
    let settings = match read_settings(state, user).await {
        Ok(settings) => settings,
        Err(error) => return (Vec::new(), Some(error.message)),
    };
    let Some(key) = connected_key(&settings) else {
        return (Vec::new(), None);
    };
    match list_documents(state, &key).await {
        Ok(documents) => (top_level_summaries_of(&documents), None),
        Err(error) => (Vec::new(), Some(error.message)),
    }
}

pub(super) async fn read_context(state: &AppState, user: &User, id: &str) -> ReadOutcome {
    let settings = match read_settings(state, user).await {
        Ok(settings) => settings,
        Err(error) => return ReadOutcome::Unavailable(error.message),
    };
    let Some(key) = connected_key(&settings) else {
        return ReadOutcome::NotConnected;
    };
    let detail = match get_document(state, &key, id).await {
        Ok(Some(detail)) => detail,
        Ok(None) => return ReadOutcome::NotFound,
        Err(error) => return ReadOutcome::Unavailable(error.message),
    };
    let children = match list_documents(state, &key).await {
        Ok(documents) => child_summaries_of(&documents, id),
        Err(error) => return ReadOutcome::Unavailable(error.message),
    };
    let description = document_description(&detail.document);
    ReadOutcome::Found(ContextReadView {
        context: ContextView {
            id: detail.document.id,
            name: detail.document.title,
            description,
            content: detail.revision.content,
            parent_id: detail.document.parent_id,
        },
        children,
    })
}

fn connected_key(settings: &IntegrationSettings) -> Option<String> {
    (!settings.ctx_api_key.is_empty()).then(|| settings.ctx_api_key.clone())
}

fn top_level_summaries_of(documents: &[CtxDocument]) -> Vec<ContextSummary> {
    summarize(
        documents
            .iter()
            .filter(|document| document.kind != "profile" && document.parent_id.is_none()),
    )
}

fn child_summaries_of(documents: &[CtxDocument], parent_id: &str) -> Vec<ContextSummary> {
    summarize(
        documents
            .iter()
            .filter(|document| document.parent_id.as_deref() == Some(parent_id)),
    )
}

fn summarize<'a>(documents: impl Iterator<Item = &'a CtxDocument>) -> Vec<ContextSummary> {
    let mut items: Vec<ContextSummary> = documents
        .map(|document| ContextSummary {
            context_id: document.id.clone(),
            name: document.title.clone(),
            description: document_description(document),
        })
        .collect();
    items.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.context_id.cmp(&b.context_id))
    });
    items
}

fn document_description(document: &CtxDocument) -> String {
    document
        .metadata
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

async fn read_settings(state: &AppState, user: &User) -> Result<IntegrationSettings, ApiError> {
    user_db(state, user, true, |connection| {
        integration_settings(connection)
    })
    .await
}

async fn send(
    request: reqwest::RequestBuilder,
    operation: &str,
) -> Result<reqwest::Response, ApiError> {
    request
        .send()
        .await
        .map_err(|error| ApiError::unavailable(format!("CTX {operation} failed: {error}")))
}

fn request(
    state: &AppState,
    bearer: &str,
    method: reqwest::Method,
    segments: &[&str],
) -> Result<reqwest::RequestBuilder, ApiError> {
    let mut url = url::Url::parse(&state.ctx_api_url).map_err(ApiError::internal)?;
    url.path_segments_mut()
        .map_err(|_| ApiError::internal("CTX URL must support path segments"))?
        .pop_if_empty()
        .extend(segments);
    Ok(state
        .client
        .request(method, url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(15)))
}

async fn checked(
    response: reqwest::Response,
    operation: &str,
) -> Result<reqwest::Response, ApiError> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ApiError::unavailable(format!(
            "CTX {operation} failed: the session is not authorized for ctx.ntnl.io (HTTP 401); sign in again and retry"
        )));
    }
    if !response.status().is_success() {
        return Err(ApiError::unavailable(format!(
            "CTX {operation} failed (HTTP {})",
            response.status().as_u16(),
        )));
    }
    Ok(response)
}

async fn list_documents(state: &AppState, key: &str) -> Result<Vec<CtxDocument>, ApiError> {
    let response = send(
        request(
            state,
            key,
            reqwest::Method::GET,
            &["api", "v1", "documents"],
        )?,
        "list documents",
    )
    .await?;
    checked(response, "list documents")
        .await?
        .json()
        .await
        .map_err(ApiError::internal)
}

async fn get_document(
    state: &AppState,
    key: &str,
    id: &str,
) -> Result<Option<CtxDocumentDetail>, ApiError> {
    let response = send(
        request(
            state,
            key,
            reqwest::Method::GET,
            &["api", "v1", "documents", id],
        )?,
        "read document",
    )
    .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    Ok(Some(
        checked(response, "read document")
            .await?
            .json()
            .await
            .map_err(ApiError::internal)?,
    ))
}

async fn create_key(
    state: &AppState,
    bearer: &str,
    label: &str,
) -> Result<CtxCreatedKey, ApiError> {
    let response = send(
        request(
            state,
            bearer,
            reqwest::Method::POST,
            &["api", "v1", "api-keys"],
        )?
        .json(&json!({ "label": label })),
        "create API key",
    )
    .await?;
    checked(response, "create API key")
        .await?
        .json()
        .await
        .map_err(ApiError::internal)
}

async fn revoke_key(state: &AppState, bearer: &str, key_id: &str) -> Result<(), ApiError> {
    let response = send(
        request(
            state,
            bearer,
            reqwest::Method::DELETE,
            &["api", "v1", "api-keys", key_id],
        )?,
        "revoke API key",
    )
    .await?;
    checked(response, "revoke API key").await?;
    Ok(())
}
