use super::*;

/// One configured Responses-compatible endpoint. `api_key` is stored per user
/// and never leaves the server.
#[derive(Clone, Debug)]
pub(super) struct Upstream {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) base_url: String,
    pub(super) api_key: String,
}

#[derive(Debug, Serialize)]
pub(super) struct UpstreamView {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) base_url: String,
    pub(super) api_key_configured: bool,
}

#[derive(Debug, Serialize)]
pub(super) struct UpstreamModelsView {
    pub(super) upstreams: Vec<UpstreamCatalogView>,
}

#[derive(Debug, Serialize)]
pub(super) struct UpstreamCatalogView {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) models: Vec<String>,
    pub(super) error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateUpstreamInput {
    pub(super) name: String,
    pub(super) base_url: String,
    #[serde(default)]
    pub(super) api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateUpstreamInput {
    pub(super) name: String,
    pub(super) base_url: String,
    #[serde(default)]
    pub(super) api_key: Option<String>,
}

#[derive(Deserialize)]
struct ModelCatalog {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

fn upstream_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Upstream> {
    Ok(Upstream {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        api_key: row.get(3)?,
    })
}

fn view(upstream: &Upstream) -> UpstreamView {
    UpstreamView {
        id: upstream.id.clone(),
        name: upstream.name.clone(),
        base_url: upstream.base_url.clone(),
        api_key_configured: !upstream.api_key.is_empty(),
    }
}

pub(super) fn load_all(connection: &Connection) -> Result<Vec<Upstream>, ApiError> {
    let mut statement =
        connection.prepare("SELECT id,name,base_url,api_key FROM upstreams ORDER BY name,id")?;
    let rows = statement.query_map([], upstream_from_row)?;
    let mut upstreams = Vec::new();
    for row in rows {
        upstreams.push(row?);
    }
    Ok(upstreams)
}

pub(super) fn load(connection: &Connection, id: &str) -> Result<Upstream, ApiError> {
    connection
        .query_row(
            "SELECT id,name,base_url,api_key FROM upstreams WHERE id=?",
            [id],
            upstream_from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("upstream not found"))
}

pub(super) fn exists(connection: &Connection, id: &str) -> Result<bool, ApiError> {
    Ok(connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM upstreams WHERE id=?)",
        [id],
        |row| row.get(0),
    )?)
}

pub(super) fn for_thread(
    connection: &Connection,
    thread: &ThreadView,
) -> Result<Option<Upstream>, ApiError> {
    for_thread_id(connection, thread.upstream_id.as_deref())
}

pub(super) fn for_thread_id(
    connection: &Connection,
    id: Option<&str>,
) -> Result<Option<Upstream>, ApiError> {
    let Some(id) = id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let upstream = connection
        .query_row(
            "SELECT id,name,base_url,api_key FROM upstreams WHERE id=?",
            [id],
            upstream_from_row,
        )
        .optional()?;
    Ok(upstream)
}

pub(super) fn upstream_id(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| ApiError::not_found("upstream not found"))
}

/// Derives the initial upstream name from its URL host, used by the schema-16
/// migration of the pre-upstream single configuration.
pub(super) fn name_from_base_url(base_url: &str) -> String {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "default".to_owned())
}

fn validate_name(value: &str) -> Result<String, ApiError> {
    label(value, "name", 80)
}

fn validate_base_url(value: String) -> Result<String, ApiError> {
    let value = value.trim().trim_end_matches('/').to_owned();
    let parsed = url::Url::parse(&value)
        .map_err(|_| ApiError::bad_request("base_url must be a valid HTTP or HTTPS URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ApiError::bad_request(
            "base_url must be a valid HTTP or HTTPS URL",
        ));
    }
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "base_url must contain at most 2048 visible characters",
        ));
    }
    Ok(value)
}

fn validate_api_key(value: String) -> Result<String, ApiError> {
    let value = value.trim().to_owned();
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "api_key must contain at most 4096 visible characters",
        ));
    }
    Ok(value)
}

fn require_unique_name(connection: &Connection, name: &str, exclude: &str) -> Result<(), ApiError> {
    let taken: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM upstreams WHERE name=? AND id<>?)",
        params![name, exclude],
        |row| row.get(0),
    )?;
    if taken {
        return Err(ApiError::conflict(
            "an upstream with this name already exists",
        ));
    }
    Ok(())
}

pub(super) async fn list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<UpstreamView>>, ApiError> {
    let views: Vec<UpstreamView> = user_db(&state, &identity.user, true, move |connection| {
        Ok(load_all(connection)?.iter().map(view).collect())
    })
    .await?;
    Ok(Json(views))
}

pub(super) async fn create(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateUpstreamInput>,
) -> Result<Json<UpstreamView>, ApiError> {
    let name = validate_name(&input.name)?;
    let base_url = validate_base_url(input.base_url)?;
    let api_key = validate_api_key(input.api_key.unwrap_or_default())?;
    let view = user_db(&state, &identity.user, true, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_unique_name(&transaction, &name, "")?;
        let upstream = Upstream {
            id: Uuid::now_v7().to_string(),
            name,
            base_url,
            api_key,
        };
        transaction.execute(
            "INSERT INTO upstreams(id,name,base_url,api_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            params![
                upstream.id,
                upstream.name,
                upstream.base_url,
                upstream.api_key,
                now(),
                now()
            ],
        )?;
        transaction.commit()?;
        Ok(view(&upstream))
    })
    .await?;
    Ok(Json(view))
}

pub(super) async fn update(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UpdateUpstreamInput>,
) -> Result<Json<UpstreamView>, ApiError> {
    let id = upstream_id(&id)?;
    let name = validate_name(&input.name)?;
    let base_url = validate_base_url(input.base_url)?;
    let api_key = input.api_key.map(validate_api_key).transpose()?;
    let view = user_db(&state, &identity.user, true, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut upstream = load(&transaction, &id)?;
        require_unique_name(&transaction, &name, &id)?;
        upstream.name = name;
        upstream.base_url = base_url;
        if let Some(api_key) = api_key {
            upstream.api_key = api_key;
        }
        transaction.execute(
            "UPDATE upstreams SET name=?,base_url=?,api_key=?,updated_at=? WHERE id=?",
            params![
                upstream.name,
                upstream.base_url,
                upstream.api_key,
                now(),
                upstream.id
            ],
        )?;
        transaction.commit()?;
        Ok(view(&upstream))
    })
    .await?;
    Ok(Json(view))
}

pub(super) async fn delete(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = upstream_id(&id)?;
    user_db(&state, &identity.user, true, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !exists(&transaction, &id)? {
            return Err(ApiError::not_found("upstream not found"));
        }
        let used: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE upstream_id=?1)
                     OR EXISTS(SELECT 1 FROM thread_defaults WHERE upstream_id=?1)",
            [&id],
            |row| row.get(0),
        )?;
        if used {
            return Err(ApiError::conflict(
                "upstream is used by existing threads or thread defaults",
            ));
        }
        transaction.execute("DELETE FROM upstreams WHERE id=?", [&id])?;
        transaction.commit()?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn models(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<UpstreamModelsView>, ApiError> {
    let upstreams = user_db(&state, &identity.user, true, |connection| {
        load_all(connection)
    })
    .await?;
    // ASSUMPTION: a failing upstream only fails its own catalog group; the
    // browser shows the error next to that upstream and keeps offering the
    // models of every healthy upstream.
    let catalogs = futures_util::future::join_all(upstreams.iter().map(|upstream| {
        let state = state.clone();
        async move {
            // INVARIANT: the hosted OpenAI-LB proxy rejects every /v1 request
            // without a non-empty session-id header. Other providers ignore the
            // header, so one request path serves every upstream.
            match fetch_models(&state, upstream).await {
                Ok(models) => UpstreamCatalogView {
                    id: upstream.id.clone(),
                    name: upstream.name.clone(),
                    models,
                    error: None,
                },
                Err(error) => UpstreamCatalogView {
                    id: upstream.id.clone(),
                    name: upstream.name.clone(),
                    models: Vec::new(),
                    error: Some(error.message),
                },
            }
        }
    }))
    .await;
    Ok(Json(UpstreamModelsView {
        upstreams: catalogs,
    }))
}

async fn fetch_models(state: &AppState, upstream: &Upstream) -> Result<Vec<String>, ApiError> {
    let response = state
        .client
        .get(format!(
            "{}/models",
            upstream.base_url.trim_end_matches('/')
        ))
        .bearer_auth(upstream.api_key.as_str())
        .timeout(Duration::from_secs(15))
        .header(SESSION_ID_HEADER, Uuid::new_v4().to_string())
        .send()
        .await?
        .error_for_status()?;
    let catalog = response.json::<ModelCatalog>().await?;
    Ok(catalog.data.into_iter().map(|model| model.id).collect())
}

#[cfg(test)]
#[path = "upstreams/tests.rs"]
mod tests;
