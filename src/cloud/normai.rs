use super::upstreams::{Upstream, UpstreamView};
use super::*;

/// The consumer Cybion manages for this user on NormAI. Its credential is
/// stored as the user's `NormAI` upstream; the controller owns that row.
const NORMAI_UPSTREAM_NAME: &str = "NormAI";

#[derive(Debug, Deserialize)]
struct NormaiConsumer {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct NormaiCredential {
    secret: String,
}

pub(super) async fn connect(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<UpstreamView>, ApiError> {
    Ok(Json(
        connect_for(&state, &identity.user, &identity.bearer).await?,
    ))
}

pub(super) async fn rotate(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<UpstreamView>, ApiError> {
    Ok(Json(
        rotate_for(&state, &identity.user, &identity.bearer).await?,
    ))
}

/// Idempotent: an already stored credential is returned as-is so the automatic
/// call on every workspace load never reissues a working key.
pub(super) async fn connect_for(
    state: &AppState,
    user: &User,
    bearer: &str,
) -> Result<UpstreamView, ApiError> {
    let _guard = lock_integrations(state, format!("normai:{}", user.id)).await;
    if let Some(upstream) = connected_upstream(state, user).await? {
        return Ok(upstreams::view(&upstream));
    }
    issue_and_save(state, user, bearer).await
}

/// Reissues the credential even when one is already stored.
pub(super) async fn rotate_for(
    state: &AppState,
    user: &User,
    bearer: &str,
) -> Result<UpstreamView, ApiError> {
    let _guard = lock_integrations(state, format!("normai:{}", user.id)).await;
    issue_and_save(state, user, bearer).await
}

async fn issue_and_save(
    state: &AppState,
    user: &User,
    bearer: &str,
) -> Result<UpstreamView, ApiError> {
    let secret = issue_consumer_key(state, bearer).await?;
    save_upstream(state, user, secret).await
}

async fn connected_upstream(state: &AppState, user: &User) -> Result<Option<Upstream>, ApiError> {
    user_db(state, user, true, |connection| {
        Ok(upstreams::load_all(connection)?
            .into_iter()
            .find(|upstream| is_normai(upstream) && !upstream.api_key.is_empty()))
    })
    .await
}

async fn save_upstream(
    state: &AppState,
    user: &User,
    secret: String,
) -> Result<UpstreamView, ApiError> {
    user_db(state, user, true, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let upstream = match upstreams::load_all(&transaction)?.into_iter().find(is_normai) {
            Some(mut upstream) => {
                upstream.api_key = secret;
                transaction.execute(
                    "UPDATE upstreams SET api_key=?,updated_at=? WHERE id=?",
                    params![upstream.api_key, now(), upstream.id],
                )?;
                upstream
            }
            None => {
                let upstream = Upstream {
                    id: Uuid::now_v7().to_string(),
                    name: NORMAI_UPSTREAM_NAME.to_owned(),
                    base_url: format!("{NORMAI_API_URL}/v1"),
                    api_key: secret,
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
                upstream
            }
        };
        // New users follow the hosted default: bind NormAI only while no other
        // default upstream was chosen.
        transaction.execute(
            "INSERT OR IGNORE INTO thread_defaults(id,model,upstream_id,reasoning_effort,service_tier_fast,context_budget_tokens,minimal_mode) VALUES(1,?,?,?,0,?,0)",
            params![
                DEFAULT_MODEL,
                upstream.id,
                "medium",
                DEFAULT_CONTEXT_BUDGET_TOKENS
            ],
        )?;
        transaction.execute(
            "UPDATE thread_defaults SET upstream_id=? WHERE id=1 AND upstream_id IS NULL",
            [&upstream.id],
        )?;
        transaction.commit()?;
        Ok(upstreams::view(&upstream))
    })
    .await
}

fn is_normai(upstream: &Upstream) -> bool {
    url::Url::parse(&upstream.base_url)
        .map(|url| url.host_str() == Some("normai.ntnl.io"))
        .unwrap_or(false)
}

/// Reuses the user's existing `Cybion` consumer by rotating it; a second
/// consumer is only created when none exists yet.
async fn issue_consumer_key(state: &AppState, bearer: &str) -> Result<String, ApiError> {
    let consumers = list_consumers(state, bearer).await?;
    if let Some(consumer) = consumers
        .into_iter()
        .find(|consumer| consumer.name == INTEGRATION_NAME)
    {
        return rotate_consumer(state, bearer, &consumer.id).await;
    }
    create_consumer(state, bearer, INTEGRATION_NAME).await
}

async fn list_consumers(state: &AppState, bearer: &str) -> Result<Vec<NormaiConsumer>, ApiError> {
    checked(
        send(
            request(state, bearer, reqwest::Method::GET, &["api", "consumers"])?,
            "list consumers",
        )
        .await?,
        "list consumers",
    )
    .await?
    .json()
    .await
    .map_err(ApiError::internal)
}

async fn create_consumer(state: &AppState, bearer: &str, name: &str) -> Result<String, ApiError> {
    let credential = checked(
        send(
            request(state, bearer, reqwest::Method::POST, &["api", "consumers"])?
                .json(&json!({ "name": name })),
            "create consumer",
        )
        .await?,
        "create consumer",
    )
    .await?
    .json::<NormaiCredential>()
    .await
    .map_err(ApiError::internal)?;
    Ok(credential.secret)
}

async fn rotate_consumer(state: &AppState, bearer: &str, id: &str) -> Result<String, ApiError> {
    let credential = checked(
        send(
            request(
                state,
                bearer,
                reqwest::Method::POST,
                &["api", "consumers", id, "rotate"],
            )?,
            "rotate consumer",
        )
        .await?,
        "rotate consumer",
    )
    .await?
    .json::<NormaiCredential>()
    .await
    .map_err(ApiError::internal)?;
    Ok(credential.secret)
}

fn request(
    state: &AppState,
    bearer: &str,
    method: reqwest::Method,
    segments: &[&str],
) -> Result<reqwest::RequestBuilder, ApiError> {
    let mut url = url::Url::parse(&state.normai_api_url).map_err(ApiError::internal)?;
    url.path_segments_mut()
        .map_err(|_| ApiError::internal("NormAI URL must support path segments"))?
        .pop_if_empty()
        .extend(segments);
    Ok(state
        .client
        .request(method, url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(15)))
}

async fn send(
    request: reqwest::RequestBuilder,
    operation: &str,
) -> Result<reqwest::Response, ApiError> {
    request
        .send()
        .await
        .map_err(|error| ApiError::unavailable(format!("NormAI {operation} failed: {error}")))
}

async fn checked(
    response: reqwest::Response,
    operation: &str,
) -> Result<reqwest::Response, ApiError> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ApiError::unavailable(format!(
            "NormAI {operation} failed: the session is not authorized for normai.ntnl.io (HTTP 401); sign in again and retry"
        )));
    }
    if !response.status().is_success() {
        return Err(ApiError::unavailable(format!(
            "NormAI {operation} failed (HTTP {})",
            response.status().as_u16(),
        )));
    }
    Ok(response)
}
