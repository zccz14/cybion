use std::{
    collections::HashMap,
    convert::Infallible,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use auth_mini_axum::{AuthMiniLayer, JwksCachePolicy};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, Request, State},
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{Next, from_fn_with_state},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{delete, get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OnceCell};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

const AUTH_ISSUER: &str = "https://auth.ntnl.io";
const AUTH_AUDIENCE: &str = "cybion.ntnl.io";
const AUTH_AUDIENCES: [&str; 3] = ["cybion.ntnl.io", "linkit.ntnl.io", "openai.ntnl.io"];
const OPENAI_CONSUMERS_URL: &str = "https://openai.ntnl.io/api/consumers";
const OPENAI_BASE_URL: &str = "https://openai.ntnl.io/v1";
const LINKIT_API_URL: &str = "https://linkit.ntnl.io";
const INTEGRATION_NAME: &str = "Cybion";
const DEFAULT_MODEL: &str = "gpt-5.6-terra";
const WORKER_ONLINE_SECONDS: i64 = 45;
const WORKER_RESULT_TIMEOUT_SECONDS: usize = 15 * 60;

// The browser bearer is minted for all three resource hosts. Cybion forwards
// that ordinary Auth Mini token only to each service's existing user API; no
// downstream service receives Cybion-specific context.

#[derive(Clone)]
struct AppState {
    data_dir: Arc<PathBuf>,
    client: reqwest::Client,
    auth: Arc<OnceCell<AuthMiniLayer>>,
    integration_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

#[derive(Clone, Debug)]
struct Tenant {
    id: String,
    path: PathBuf,
}

#[derive(Clone, Debug)]
struct BrowserIdentity {
    tenant: Tenant,
    bearer: String,
}

#[derive(Clone, Debug)]
struct ApiIdentity {
    tenant: Tenant,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }

    fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!(%cause, "Cybion request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Cybion could not complete the request".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(cause: rusqlite::Error) -> Self {
        Self::internal(cause)
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(cause: reqwest::Error) -> Self {
        Self::unavailable(format!("integration request failed: {cause}"))
    }
}

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

pub async fn serve() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("cannot install Rustls crypto provider"))?;
    tracing_subscriber::fmt()
        .with_env_filter("cybion=info,tower_http=info")
        .compact()
        .init();
    let home = directories::BaseDirs::new()
        .context("cannot determine the current user's home directory")?
        .home_dir()
        .to_path_buf();
    let data_dir = home.join(".cybion");
    prepare_data_dir(&data_dir)?;
    let run_dir = data_dir.join("run");
    fs::create_dir_all(&run_dir)?;
    fs::write(
        run_dir.join("started.json"),
        json!({"pid": std::process::id(), "version": env!("CARGO_PKG_VERSION")}).to_string(),
    )?;
    let state = AppState {
        data_dir: Arc::new(data_dir),
        client: reqwest::Client::builder()
            .user_agent(format!("cybion-cloud/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(600))
            .build()?,
        auth: Arc::new(OnceCell::new()),
        integration_locks: Arc::new(Mutex::new(HashMap::new())),
    };
    let address: SocketAddr = "0.0.0.0:1858".parse().expect("constant address is valid");
    tracing::info!(%address, "Cybion Cloud listening");
    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, app(state)).await?;
    Ok(())
}

fn prepare_data_dir(data_dir: &Path) -> Result<()> {
    fs::create_dir_all(data_dir.join("tenants"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(data_dir, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(data_dir.join("tenants"), fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn app(state: AppState) -> Router {
    let browser_api = Router::new()
        .route("/api/me", get(me))
        .route("/api/threads", get(list_threads).post(create_thread))
        .route(
            "/api/threads/{id}",
            get(read_thread).patch(update_thread).delete(delete_thread),
        )
        .route("/api/threads/{id}/history", get(thread_history))
        .route("/api/threads/{id}/turn", post(thread_turn))
        .route("/api/api-keys", get(list_api_keys).post(create_api_key))
        .route("/api/api-keys/{id}", delete(delete_api_key))
        .route(
            "/api/workers",
            get(list_workers).post(create_worker_pairing),
        )
        .route("/api/workers/{id}", delete(delete_worker))
        .route_layer(from_fn_with_state(state.clone(), browser_auth));

    let external_api = Router::new()
        .route("/v1/threads", post(external_create_thread))
        .route("/v1/threads/{id}", get(external_read_thread))
        .route("/v1/threads/{id}/history", get(external_thread_history))
        .route("/v1/threads/{id}/inputs", post(external_thread_input))
        .route_layer(from_fn_with_state(state.clone(), api_key_auth));

    Router::new()
        .route("/health", get(health))
        .route("/api/config", get(public_config))
        .merge(browser_api)
        .merge(external_api)
        .route(
            "/worker/v1/tenants/{tenant_id}/workers/{worker_id}/events",
            get(worker_events),
        )
        .route(
            "/worker/v1/tenants/{tenant_id}/workers/{worker_id}/heartbeat",
            post(worker_heartbeat),
        )
        .route(
            "/worker/v1/tenants/{tenant_id}/workers/{worker_id}/resources",
            post(worker_resources),
        )
        .route(
            "/worker/v1/tenants/{tenant_id}/workers/{worker_id}/calls/{call_id}/result",
            post(worker_result),
        )
        .fallback(static_asset)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

async fn public_config() -> Json<Value> {
    Json(json!({
        "auth_issuer": AUTH_ISSUER,
        "auth_audience": AUTH_AUDIENCE,
        "auth_audiences": AUTH_AUDIENCES,
        "hosted": true,
        "version": env!("CARGO_PKG_VERSION")
    }))
}

async fn static_asset(uri: Uri) -> Response {
    if ["/api", "/v1", "/worker"]
        .iter()
        .any(|prefix| uri.path() == *prefix || uri.path().starts_with(&format!("{prefix}/")))
    {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"route not found"})),
        )
            .into_response();
    }
    let requested = uri.path().trim_start_matches('/');
    let requested = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let fallback = Assets::get(requested).is_none();
    match Assets::get(requested).or_else(|| Assets::get("index.html")) {
        Some(asset) => {
            let content_type = if fallback || requested == "index.html" {
                "text/html; charset=utf-8"
            } else {
                match requested.rsplit('.').next() {
                    Some("js") => "text/javascript; charset=utf-8",
                    Some("css") => "text/css; charset=utf-8",
                    Some("svg") => "image/svg+xml",
                    Some("png") => "image/png",
                    Some("woff2") => "font/woff2",
                    _ => "application/octet-stream",
                }
            };
            (
                [(header::CONTENT_TYPE, content_type)],
                Body::from(asset.data),
            )
                .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn tenant_id(subject: &str) -> String {
    hex::encode(Sha256::digest(subject.as_bytes()))
}

fn tenant_for_subject(state: &AppState, subject: &str) -> Tenant {
    tenant_from_id(state, tenant_id(subject)).expect("a SHA-256 digest is a tenant id")
}

fn tenant_from_id(state: &AppState, id: String) -> Result<Tenant, ApiError> {
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::unauthorized("invalid tenant credential"));
    }
    Ok(Tenant {
        path: state.data_dir.join("tenants").join(format!("{id}.sqlite3")),
        id,
    })
}

fn bearer(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::unauthorized("Bearer token is required"))
}

async fn browser_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<BrowserIdentity, ApiError> {
    let bearer = bearer(headers)?;
    let layer = state
        .auth
        .get_or_try_init(|| async {
            AuthMiniLayer::from_issuer(
                AUTH_ISSUER,
                AUTH_AUDIENCE.to_owned(),
                JwksCachePolicy::default(),
            )
            .await
            .map_err(|_| ApiError::unavailable("Auth Mini JWKS is unavailable"))
        })
        .await?
        .clone();
    let principal = layer
        .verifier()
        .verify(&bearer)
        .await
        .map_err(|_| ApiError::unauthorized("invalid or expired bearer token"))?;
    Ok(BrowserIdentity {
        tenant: tenant_for_subject(state, &principal.subject),
        bearer,
    })
}

async fn browser_auth(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    match browser_identity(&state, request.headers()).await {
        Ok(identity) => {
            request.extensions_mut().insert(identity);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

fn open_tenant(path: &Path, create: bool) -> Result<Connection, ApiError> {
    if !create && !path.is_file() {
        return Err(ApiError::unauthorized("invalid tenant credential"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("tenant path has no parent"))?;
    fs::create_dir_all(parent).map_err(ApiError::internal)?;
    let connection = Connection::open(path).map_err(ApiError::internal)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(ApiError::internal)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(ApiError::internal)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(ApiError::internal)?;
    connection
        .execute_batch(TENANT_SCHEMA)
        .map_err(ApiError::internal)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(ApiError::internal)?;
    }
    Ok(connection)
}

async fn tenant_db<T, F>(
    _state: &AppState,
    tenant: &Tenant,
    create: bool,
    operation: F,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
{
    let path = tenant.path.clone();
    tokio::task::spawn_blocking(move || {
        let mut connection = open_tenant(&path, create)?;
        operation(&mut connection)
    })
    .await
    .map_err(ApiError::internal)?
}

const TENANT_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('idle','running','failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_records_thread_created ON history_records(thread_id,id);
CREATE TABLE IF NOT EXISTS thread_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS thread_runs_thread_started ON thread_runs(thread_id,started_at DESC);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS integration_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  openai_consumer_id TEXT NOT NULL DEFAULT '',
  openai_consumer_secret TEXT NOT NULL DEFAULT '',
  openai_base_url TEXT NOT NULL DEFAULT 'https://openai.ntnl.io/v1',
  linkit_bot_id TEXT NOT NULL DEFAULT '',
  linkit_bot_token TEXT NOT NULL DEFAULT '',
  linkit_username TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline')),
  resource_json TEXT
);
CREATE TABLE IF NOT EXISTS worker_calls (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','delivered','completed','failed')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS worker_calls_delivery ON worker_calls(worker_id,status,created_at);
"#;

// Route implementations live below the persistence model so the tenant boundary
// remains explicit in every read and write.

#[derive(Clone, Serialize)]
struct ThreadView {
    id: String,
    title: String,
    model: String,
    status: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Serialize)]
struct HistoryRecord {
    id: i64,
    thread_id: String,
    role: String,
    content: String,
    created_at: i64,
}

#[derive(Clone, Serialize)]
struct RunView {
    id: String,
    thread_id: String,
    status: String,
    error: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateThreadInput {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateThreadInput {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TurnInput {
    input: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateApiKeyInput {
    label: String,
}

#[derive(Clone, Serialize)]
struct ApiKeyView {
    id: String,
    label: String,
    prefix: String,
    created_at: i64,
    last_used_at: Option<i64>,
}

#[derive(Serialize)]
struct CreatedApiKey {
    #[serde(flatten)]
    key: ApiKeyView,
    secret: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateWorkerInput {
    label: String,
}

#[derive(Clone, Serialize)]
struct WorkerView {
    id: String,
    label: String,
    created_at: i64,
    last_seen_at: Option<i64>,
    status: String,
    resource: Option<Value>,
}

#[derive(Serialize)]
struct WorkerPairing {
    controller_url: &'static str,
    tenant_id: String,
    machine_id: String,
    access_token: String,
}

#[derive(Clone)]
struct WorkerCall {
    id: String,
    thread_id: String,
    name: String,
    arguments: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerHeartbeat {
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerResultInput {
    result: Value,
    #[serde(default)]
    failed: bool,
}

#[derive(Clone)]
struct IntegrationSettings {
    openai_consumer_id: String,
    openai_consumer_secret: String,
    openai_base_url: String,
    linkit_bot_id: String,
    linkit_bot_token: String,
    linkit_username: String,
}

#[derive(Deserialize)]
struct OpenAiConsumerGrant {
    id: String,
    secret: String,
}

#[derive(Deserialize)]
struct LinkitMe {
    profile: Option<LinkitProfile>,
}

#[derive(Deserialize)]
struct LinkitProfile {
    username: String,
}

#[derive(Deserialize)]
struct LinkitBotGrant {
    id: String,
    token: String,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn thread_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadView> {
    Ok(ThreadView {
        id: row.get(0)?,
        title: row.get(1)?,
        model: row.get(2)?,
        status: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRecord> {
    Ok(HistoryRecord {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn thread_id(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| ApiError::not_found("thread not found"))
}

fn record_id(value: &str) -> Result<String, ApiError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| ApiError::not_found("record not found"))
}

fn label(value: &str, field: &str, max: usize) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "{field} must contain 1-{max} visible characters"
        )));
    }
    Ok(value.to_owned())
}

fn optional_title(value: Option<String>) -> Result<String, ApiError> {
    match value {
        Some(value) => label(&value, "title", 160),
        None => Ok("Untitled thread".to_owned()),
    }
}

fn model_id(value: Option<String>) -> Result<String, ApiError> {
    let value = value.unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ApiError::bad_request(
            "model must be a supported model identifier",
        ));
    }
    Ok(value.to_owned())
}

fn input_text(value: String) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100_000 {
        return Err(ApiError::bad_request(
            "input must contain 1-100000 characters",
        ));
    }
    Ok(value.to_owned())
}

fn load_thread(connection: &Connection, id: &str) -> Result<ThreadView, ApiError> {
    connection
        .query_row(
            "SELECT id,title,model,status,created_at,updated_at FROM threads WHERE id=?",
            [id],
            thread_from_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("thread not found"))
}

async fn create_thread_for(
    state: &AppState,
    tenant: &Tenant,
    input: CreateThreadInput,
) -> Result<ThreadView, ApiError> {
    let thread = ThreadView {
        id: Uuid::new_v4().to_string(),
        title: optional_title(input.title)?,
        model: model_id(input.model)?,
        status: "idle".to_owned(),
        created_at: now(),
        updated_at: now(),
    };
    tenant_db(state, tenant, true, move |connection| {
        connection.execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            params![
                thread.id,
                thread.title,
                thread.model,
                thread.status,
                thread.created_at,
                thread.updated_at
            ],
        )?;
        Ok(thread)
    })
    .await
}

async fn list_threads_for(state: &AppState, tenant: &Tenant) -> Result<Vec<ThreadView>, ApiError> {
    tenant_db(state, tenant, true, |connection| {
        let mut statement = connection.prepare(
            "SELECT id,title,model,status,created_at,updated_at FROM threads ORDER BY updated_at DESC,id DESC",
        )?;
        let rows = statement.query_map([], thread_from_row)?;
        let mut threads = Vec::new();
        for row in rows {
            threads.push(row?);
        }
        Ok(threads)
    })
    .await
}

async fn read_thread_for(
    state: &AppState,
    tenant: &Tenant,
    id: String,
) -> Result<ThreadView, ApiError> {
    tenant_db(state, tenant, true, move |connection| {
        load_thread(connection, &id)
    })
    .await
}

async fn me(
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"tenant_id": identity.tenant.id, "hosted": true}),
    ))
}

async fn list_threads(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<ThreadView>>, ApiError> {
    Ok(Json(list_threads_for(&state, &identity.tenant).await?))
}

async fn create_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateThreadInput>,
) -> Result<Json<ThreadView>, ApiError> {
    Ok(Json(
        create_thread_for(&state, &identity.tenant, input).await?,
    ))
}

async fn read_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ThreadView>, ApiError> {
    Ok(Json(
        read_thread_for(&state, &identity.tenant, thread_id(&id)?).await?,
    ))
}

async fn update_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UpdateThreadInput>,
) -> Result<Json<ThreadView>, ApiError> {
    let id = thread_id(&id)?;
    let title = input
        .title
        .map(|value| label(&value, "title", 160))
        .transpose()?;
    let model = input.model.map(|value| model_id(Some(value))).transpose()?;
    if title.is_none() && model.is_none() {
        return Err(ApiError::bad_request("thread update is empty"));
    }
    let updated_at = now();
    let thread = tenant_db(&state, &identity.tenant, true, move |connection| {
        let changed = connection.execute(
            "UPDATE threads SET title=COALESCE(?,title),model=COALESCE(?,model),updated_at=? WHERE id=?",
            params![title, model, updated_at, id],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found("thread not found"));
        }
        load_thread(connection, &id)
    })
    .await?;
    Ok(Json(thread))
}

async fn delete_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = thread_id(&id)?;
    tenant_db(&state, &identity.tenant, true, move |connection| {
        let changed = connection.execute("DELETE FROM threads WHERE id=?", [id])?;
        if changed == 0 {
            return Err(ApiError::not_found("thread not found"));
        }
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn thread_history(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Vec<HistoryRecord>>, ApiError> {
    let id = thread_id(&id)?;
    let records = history_for(&state, &identity.tenant, id).await?;
    Ok(Json(records))
}

async fn history_for(
    state: &AppState,
    tenant: &Tenant,
    id: String,
) -> Result<Vec<HistoryRecord>, ApiError> {
    tenant_db(state, tenant, true, move |connection| {
        load_thread(connection, &id)?;
        let mut statement = connection.prepare(
            "SELECT id,thread_id,role,content,created_at FROM history_records WHERE thread_id=? ORDER BY id",
        )?;
        let rows = statement.query_map([id], history_from_row)?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    })
    .await
}

async fn thread_turn(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<TurnInput>,
) -> Result<Json<RunView>, ApiError> {
    let id = thread_id(&id)?;
    let input = input_text(input.input)?;
    ensure_integrations(&state, &identity.tenant, &identity.bearer).await?;
    Ok(Json(enqueue_turn(state, identity.tenant, id, input).await?))
}

async fn list_api_keys(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<ApiKeyView>>, ApiError> {
    let keys = tenant_db(&state, &identity.tenant, true, |connection| {
        let mut statement = connection.prepare(
            "SELECT id,label,prefix,created_at,last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ApiKeyView {
                id: row.get(0)?,
                label: row.get(1)?,
                prefix: row.get(2)?,
                created_at: row.get(3)?,
                last_used_at: row.get(4)?,
            })
        })?;
        let mut keys = Vec::new();
        for row in rows {
            keys.push(row?);
        }
        Ok(keys)
    })
    .await?;
    Ok(Json(keys))
}

async fn create_api_key(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateApiKeyInput>,
) -> Result<Json<CreatedApiKey>, ApiError> {
    ensure_integrations(&state, &identity.tenant, &identity.bearer).await?;
    let label = label(&input.label, "label", 80)?;
    let raw_secret = Uuid::new_v4().simple().to_string();
    let key = ApiKeyView {
        id: Uuid::new_v4().to_string(),
        label,
        prefix: raw_secret[..10].to_owned(),
        created_at: now(),
        last_used_at: None,
    };
    let secret_hash = hash_secret(&raw_secret);
    let tenant_id = identity.tenant.id.clone();
    let created = tenant_db(&state, &identity.tenant, true, move |connection| {
        connection.execute(
            "INSERT INTO api_keys(id,label,prefix,secret_hash,created_at) VALUES(?,?,?,?,?)",
            params![key.id, key.label, key.prefix, secret_hash, key.created_at],
        )?;
        Ok(CreatedApiKey {
            key,
            secret: format!("cyb_{tenant_id}_{raw_secret}"),
        })
    })
    .await?;
    Ok(Json(created))
}

async fn delete_api_key(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = record_id(&id)?;
    tenant_db(&state, &identity.tenant, true, move |connection| {
        let changed = connection.execute(
            "UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
            params![now(), id],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found("API key not found"));
        }
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_workers(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<WorkerView>>, ApiError> {
    let workers = tenant_db(&state, &identity.tenant, true, |connection| {
        let mut statement = connection.prepare(
            "SELECT id,label,created_at,last_seen_at,CASE WHEN last_seen_at>=? THEN 'online' ELSE 'offline' END,resource_json FROM workers ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([now() - WORKER_ONLINE_SECONDS], |row| {
            let resource = row
                .get::<_, Option<String>>(5)?
                .and_then(|value| serde_json::from_str(&value).ok());
            Ok(WorkerView {
                id: row.get(0)?,
                label: row.get(1)?,
                created_at: row.get(2)?,
                last_seen_at: row.get(3)?,
                status: row.get(4)?,
                resource,
            })
        })?;
        let mut workers = Vec::new();
        for row in rows {
            workers.push(row?);
        }
        Ok(workers)
    })
    .await?;
    Ok(Json(workers))
}

async fn create_worker_pairing(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateWorkerInput>,
) -> Result<Json<WorkerPairing>, ApiError> {
    let worker_id = Uuid::new_v4().to_string();
    let access_token = Uuid::new_v4().simple().to_string();
    let label = label(&input.label, "label", 80)?;
    let created_at = now();
    let token_hash = hash_secret(&access_token);
    let persisted_worker_id = worker_id.clone();
    tenant_db(&state, &identity.tenant, true, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at) VALUES(?,?,?,?)",
            params![persisted_worker_id, label, token_hash, created_at],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(WorkerPairing {
        controller_url: "https://cybion.ntnl.io",
        tenant_id: identity.tenant.id,
        machine_id: worker_id,
        access_token,
    }))
}

async fn delete_worker(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = record_id(&id)?;
    tenant_db(&state, &identity.tenant, true, move |connection| {
        let changed = connection.execute("DELETE FROM workers WHERE id=?", [id])?;
        if changed == 0 {
            return Err(ApiError::not_found("worker not found"));
        }
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn hash_secret(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn integration_settings(connection: &Connection) -> Result<IntegrationSettings, ApiError> {
    let settings = connection
        .query_row(
            "SELECT openai_consumer_id,openai_consumer_secret,openai_base_url,linkit_bot_id,linkit_bot_token,linkit_username FROM integration_settings WHERE id=1",
            [],
            |row| {
                Ok(IntegrationSettings {
                    openai_consumer_id: row.get(0)?,
                    openai_consumer_secret: row.get(1)?,
                    openai_base_url: row.get(2)?,
                    linkit_bot_id: row.get(3)?,
                    linkit_bot_token: row.get(4)?,
                    linkit_username: row.get(5)?,
                })
            },
        )
        .optional()?
        .unwrap_or_else(|| IntegrationSettings {
            openai_consumer_id: String::new(),
            openai_consumer_secret: String::new(),
            openai_base_url: OPENAI_BASE_URL.to_owned(),
            linkit_bot_id: String::new(),
            linkit_bot_token: String::new(),
            linkit_username: String::new(),
        });
    Ok(settings)
}

fn integrations_ready(settings: &IntegrationSettings) -> bool {
    !settings.openai_consumer_secret.is_empty()
        && !settings.openai_base_url.is_empty()
        && !settings.linkit_bot_id.is_empty()
        && !settings.linkit_bot_token.is_empty()
        && !settings.linkit_username.is_empty()
}

async fn save_integration_settings(
    state: &AppState,
    tenant: &Tenant,
    settings: &IntegrationSettings,
) -> Result<(), ApiError> {
    let saved = settings.clone();
    tenant_db(state, tenant, true, move |connection| {
        connection.execute(
            "INSERT INTO integration_settings(id,openai_consumer_id,openai_consumer_secret,openai_base_url,linkit_bot_id,linkit_bot_token,linkit_username,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET openai_consumer_id=excluded.openai_consumer_id,openai_consumer_secret=excluded.openai_consumer_secret,openai_base_url=excluded.openai_base_url,linkit_bot_id=excluded.linkit_bot_id,linkit_bot_token=excluded.linkit_bot_token,linkit_username=excluded.linkit_username,updated_at=excluded.updated_at",
            params![
                saved.openai_consumer_id,
                saved.openai_consumer_secret,
                saved.openai_base_url,
                saved.linkit_bot_id,
                saved.linkit_bot_token,
                saved.linkit_username,
                now(),
            ],
        )?;
        Ok(())
    })
    .await
}

async fn create_openai_consumer(
    state: &AppState,
    bearer: &str,
) -> Result<OpenAiConsumerGrant, ApiError> {
    state
        .client
        .post(OPENAI_CONSUMERS_URL)
        .bearer_auth(bearer)
        .json(&json!({"name": INTEGRATION_NAME, "request_archive": true}))
        .send()
        .await?
        .error_for_status()?
        .json::<OpenAiConsumerGrant>()
        .await
        .map_err(Into::into)
}

async fn linkit_username(state: &AppState, bearer: &str) -> Result<String, ApiError> {
    let profile = state
        .client
        .get(format!("{LINKIT_API_URL}/api/me"))
        .bearer_auth(bearer)
        .send()
        .await?
        .error_for_status()?
        .json::<LinkitMe>()
        .await?;
    profile
        .profile
        .map(|profile| profile.username.trim().to_owned())
        .filter(|username| !username.is_empty())
        .ok_or_else(|| ApiError::conflict("set a Linkit username before using Cybion"))
}

async fn create_linkit_bot(state: &AppState, bearer: &str) -> Result<LinkitBotGrant, ApiError> {
    state
        .client
        .post(format!("{LINKIT_API_URL}/api/bots"))
        .bearer_auth(bearer)
        .json(&json!({"name": INTEGRATION_NAME}))
        .send()
        .await?
        .error_for_status()?
        .json::<LinkitBotGrant>()
        .await
        .map_err(Into::into)
}

async fn ensure_integrations(
    state: &AppState,
    tenant: &Tenant,
    bearer: &str,
) -> Result<IntegrationSettings, ApiError> {
    let lock = {
        let mut locks = state.integration_locks.lock().await;
        locks
            .entry(tenant.id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    let mut settings = tenant_db(state, tenant, true, |connection| {
        integration_settings(connection)
    })
    .await?;
    if settings.openai_consumer_id.is_empty() || settings.openai_consumer_secret.is_empty() {
        let grant = create_openai_consumer(state, bearer).await?;
        settings.openai_consumer_id = grant.id;
        settings.openai_consumer_secret = grant.secret;
        settings.openai_base_url = OPENAI_BASE_URL.to_owned();
        save_integration_settings(state, tenant, &settings).await?;
    }
    if settings.linkit_bot_id.is_empty()
        || settings.linkit_bot_token.is_empty()
        || settings.linkit_username.is_empty()
    {
        settings.linkit_username = linkit_username(state, bearer).await?;
        let grant = create_linkit_bot(state, bearer).await?;
        settings.linkit_bot_id = grant.id;
        settings.linkit_bot_token = grant.token;
        save_integration_settings(state, tenant, &settings).await?;
    }
    if settings.openai_base_url.is_empty() {
        settings.openai_base_url = OPENAI_BASE_URL.to_owned();
    }
    save_integration_settings(state, tenant, &settings).await?;
    Ok(settings)
}

async fn required_integrations(
    state: &AppState,
    tenant: &Tenant,
) -> Result<IntegrationSettings, ApiError> {
    let settings = tenant_db(state, tenant, false, |connection| {
        integration_settings(connection)
    })
    .await?;
    integrations_ready(&settings)
        .then_some(settings)
        .ok_or_else(|| ApiError::conflict("open this tenant once before using its external API"))
}

async fn enqueue_turn(
    state: AppState,
    tenant: Tenant,
    thread_id: String,
    input: String,
) -> Result<RunView, ApiError> {
    let run = RunView {
        id: Uuid::new_v4().to_string(),
        thread_id: thread_id.clone(),
        status: "queued".to_owned(),
        error: None,
        started_at: now(),
        finished_at: None,
    };
    let pending = run.clone();
    let queued_id = pending.id.clone();
    let queued_thread_id = pending.thread_id.clone();
    let queued_status = pending.status.clone();
    let queued_started_at = pending.started_at;
    tenant_db(&state, &tenant, true, move |connection| {
        load_thread(connection, &thread_id)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO history_records(thread_id,role,content,created_at) VALUES(?,'user',?,?)",
            params![&queued_thread_id, input, queued_started_at],
        )?;
        transaction.execute(
            "INSERT INTO thread_runs(id,thread_id,status,started_at) VALUES(?,?,?,?)",
            params![
                &queued_id,
                &queued_thread_id,
                &queued_status,
                queued_started_at
            ],
        )?;
        transaction.execute(
            "UPDATE threads SET status='running',updated_at=? WHERE id=?",
            params![queued_started_at, &queued_thread_id],
        )?;
        transaction.commit()?;
        Ok(())
    })
    .await?;
    let background_state = state.clone();
    tokio::spawn(async move {
        execute_turn(background_state, tenant, run).await;
    });
    Ok(pending)
}

async fn execute_turn(state: AppState, tenant: Tenant, run: RunView) {
    let _ = tenant_db(&state, &tenant, false, {
        let run = run.clone();
        move |connection| {
            connection.execute(
                "UPDATE thread_runs SET status='running' WHERE id=? AND status='queued'",
                [&run.id],
            )?;
            Ok(())
        }
    })
    .await;
    let context = tenant_db(&state, &tenant, false, {
        let thread_id = run.thread_id.clone();
        move |connection| {
            let thread = load_thread(connection, &thread_id)?;
            let integrations = integration_settings(connection)?;
            let mut statement = connection.prepare(
                "SELECT id,thread_id,role,content,created_at FROM history_records WHERE thread_id=? ORDER BY id",
            )?;
            let rows = statement.query_map([&thread_id], history_from_row)?;
            let mut history = Vec::new();
            for row in rows {
                history.push(row?);
            }
            let worker: Option<String> = connection
                .query_row(
                    "SELECT id FROM workers WHERE status='online' AND last_seen_at>=? ORDER BY last_seen_at DESC LIMIT 1",
                    [now() - WORKER_ONLINE_SECONDS],
                    |row| row.get(0),
                )
                .optional()?;
            Ok((thread, integrations, history, worker))
        }
    })
    .await;
    let result = match context {
        Ok((thread, integrations, history, worker)) if integrations_ready(&integrations) => {
            run_agent(&state, &tenant, &thread, &integrations, history, worker).await
        }
        Ok((thread, _, _, _)) => Err((
            thread,
            Box::new(ApiError::conflict("tenant integrations are not ready")),
        )),
        Err(error) => {
            tracing::warn!(run_id = %run.id, error = %error.message, "could not load a thread run");
            fail_run(&state, &tenant, &run, &error.message).await;
            return;
        }
    };
    match result {
        Ok((thread, integrations, output)) => {
            let output_for_db = output.clone();
            let finished_at = now();
            let completed_run_id = run.id.clone();
            let completed_thread_id = run.thread_id.clone();
            if let Err(error) = tenant_db(&state, &tenant, false, move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "INSERT INTO history_records(thread_id,role,content,created_at) VALUES(?,'assistant',?,?)",
                    params![&completed_thread_id, output_for_db, finished_at],
                )?;
                transaction.execute(
                    "UPDATE thread_runs SET status='completed',finished_at=?,error=NULL WHERE id=?",
                    params![finished_at, &completed_run_id],
                )?;
                transaction.execute(
                    "UPDATE threads SET status='idle',updated_at=? WHERE id=?",
                    params![finished_at, &completed_thread_id],
                )?;
                transaction.commit()?;
                Ok(())
            })
            .await {
                tracing::warn!(run_id = %run.id, error = %error.message, "could not finalize a completed thread run");
                return;
            }
            notify_thread(&state, &integrations, &thread, true, &output).await;
        }
        Err((thread, error)) => {
            let error_text = error.message.clone();
            if !fail_run(&state, &tenant, &run, &error_text).await {
                return;
            }
            notify_thread(
                &state,
                &integrations_for_failed(&state, &tenant).await,
                &thread,
                false,
                &error_text,
            )
            .await;
        }
    }
}

async fn fail_run(state: &AppState, tenant: &Tenant, run: &RunView, error: &str) -> bool {
    let error_for_db = error.to_owned();
    let failed_run_id = run.id.clone();
    let failed_thread_id = run.thread_id.clone();
    match tenant_db(state, tenant, false, move |connection| {
        let finished_at = now();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO history_records(thread_id,role,content,created_at) VALUES(?,'system',?,?)",
            params![
                &failed_thread_id,
                format!("Run failed: {error_for_db}"),
                finished_at
            ],
        )?;
        transaction.execute(
            "UPDATE thread_runs SET status='failed',error=?,finished_at=? WHERE id=?",
            params![error_for_db, finished_at, &failed_run_id],
        )?;
        transaction.execute(
            "UPDATE threads SET status='failed',updated_at=? WHERE id=?",
            params![finished_at, &failed_thread_id],
        )?;
        transaction.commit()?;
        Ok(())
    })
    .await
    {
        Ok(()) => true,
        Err(storage_error) => {
            tracing::warn!(run_id = %run.id, error = %storage_error.message, "could not finalize a failed thread run");
            false
        }
    }
}

async fn integrations_for_failed(state: &AppState, tenant: &Tenant) -> IntegrationSettings {
    required_integrations(state, tenant)
        .await
        .unwrap_or_else(|_| IntegrationSettings {
            openai_consumer_id: String::new(),
            openai_consumer_secret: String::new(),
            openai_base_url: OPENAI_BASE_URL.to_owned(),
            linkit_bot_id: String::new(),
            linkit_bot_token: String::new(),
            linkit_username: String::new(),
        })
}

async fn notify_thread(
    state: &AppState,
    integrations: &IntegrationSettings,
    thread: &ThreadView,
    completed: bool,
    detail: &str,
) {
    if integrations.linkit_bot_token.is_empty() || integrations.linkit_username.is_empty() {
        return;
    }
    let title = if completed {
        format!("Cybion completed · {}", thread.title)
    } else {
        format!("Cybion failed · {}", thread.title)
    };
    let body = truncate(
        &format!(
            "{title}\n\n{detail}\n\nhttps://cybion.ntnl.io/#/threads/{}",
            thread.id
        ),
        3_000,
    );
    let response = state
        .client
        .post(format!("{LINKIT_API_URL}/bot/v1/messages"))
        .bearer_auth(&integrations.linkit_bot_token)
        .json(&json!({"recipient_username": integrations.linkit_username, "body": body}))
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => tracing::warn!(
            thread_id = %thread.id,
            status = %response.status(),
            "Linkit notification failed"
        ),
        Err(error) => tracing::warn!(thread_id = %thread.id, %error, "Linkit notification failed"),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let mut end = value.len();
    for (index, _) in value.char_indices() {
        if index > limit {
            end = index;
            break;
        }
    }
    value[..end].to_owned()
}

#[derive(Clone)]
struct FunctionCall {
    call_id: String,
    name: String,
    arguments: Value,
}

async fn run_agent(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    integrations: &IntegrationSettings,
    history: Vec<HistoryRecord>,
    worker_id: Option<String>,
) -> Result<(ThreadView, IntegrationSettings, String), (ThreadView, Box<ApiError>)> {
    let input = Value::Array(
        history
            .into_iter()
            .filter(|record| matches!(record.role.as_str(), "user" | "assistant"))
            .map(|record| json!({"role":record.role,"content":record.content}))
            .collect(),
    );
    let mut response = responses_request(
        state,
        integrations,
        &thread.model,
        input,
        None,
        worker_id.is_some(),
    )
    .await
    .map_err(|error| (thread.clone(), Box::new(error)))?;
    for _ in 0..8 {
        let calls = function_calls(&response);
        if calls.is_empty() {
            return response_text(&response)
                .map(|text| (thread.clone(), integrations.clone(), text))
                .ok_or_else(|| {
                    (
                        thread.clone(),
                        Box::new(ApiError::unavailable("model returned no text output")),
                    )
                });
        }
        let Some(worker_id) = worker_id.as_deref() else {
            return Err((
                thread.clone(),
                Box::new(ApiError::conflict("no Worker is online")),
            ));
        };
        let mut outputs = Vec::with_capacity(calls.len());
        for call in calls {
            let call_id = enqueue_worker_call(
                state,
                tenant,
                worker_id,
                &thread.id,
                call.name,
                call.arguments,
            )
            .await
            .map_err(|error| (thread.clone(), Box::new(error)))?;
            let result = wait_worker_result(state, tenant, &call_id)
                .await
                .map_err(|error| (thread.clone(), Box::new(error)))?;
            outputs.push(json!({
                "type":"function_call_output",
                "call_id":call.call_id,
                "output":result.to_string(),
            }));
        }
        let previous_response_id = response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| {
                (
                    thread.clone(),
                    Box::new(ApiError::unavailable("model response has no id")),
                )
            })?;
        response = responses_request(
            state,
            integrations,
            &thread.model,
            Value::Array(outputs),
            Some(previous_response_id),
            true,
        )
        .await
        .map_err(|error| (thread.clone(), Box::new(error)))?;
    }
    Err((
        thread.clone(),
        Box::new(ApiError::unavailable(
            "agent exceeded the Worker tool-call limit",
        )),
    ))
}

async fn responses_request(
    state: &AppState,
    integrations: &IntegrationSettings,
    model: &str,
    input: Value,
    previous_response_id: Option<String>,
    include_tools: bool,
) -> Result<Value, ApiError> {
    let mut payload = json!({"model":model,"input":input});
    if let Some(previous_response_id) = previous_response_id {
        payload["previous_response_id"] = Value::String(previous_response_id);
    }
    if include_tools {
        payload["tools"] = worker_tools();
    }
    let url = format!(
        "{}/responses",
        integrations.openai_base_url.trim_end_matches('/')
    );
    state
        .client
        .post(url)
        .bearer_auth(&integrations.openai_consumer_secret)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .map_err(Into::into)
}

fn worker_tools() -> Value {
    json!([
        {
            "type":"function",
            "name":"bash",
            "description":"Run a shell command on the user's selected Cybion Worker.",
            "parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}
        },
        {
            "type":"function",
            "name":"browser_control",
            "description":"Control an isolated browser on the user's Cybion Worker.",
            "parameters":{"type":"object","properties":{"action":{"type":"string"},"url":{"type":"string"},"selector":{"type":"string"},"text":{"type":"string"}},"required":["action"],"additionalProperties":false}
        },
        {
            "type":"function",
            "name":"computer_use",
            "description":"Perform a user-device computer action through the Cybion Worker.",
            "parameters":{"type":"object","properties":{"action":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"text":{"type":"string"}},"required":["action"],"additionalProperties":false}
        }
    ])
}

fn function_calls(response: &Value) -> Vec<FunctionCall> {
    response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            (item.get("type").and_then(Value::as_str) == Some("function_call"))
                .then(|| {
                    let call_id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)?
                        .to_owned();
                    let name = item.get("name").and_then(Value::as_str)?.to_owned();
                    let arguments = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|value| serde_json::from_str(value).ok())
                        .or_else(|| item.get("arguments").cloned())
                        .unwrap_or_else(|| json!({}));
                    Some(FunctionCall {
                        call_id,
                        name,
                        arguments,
                    })
                })
                .flatten()
        })
        .collect()
}

fn response_text(response: &Value) -> Option<String> {
    response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            response.get("output")?.as_array()?.iter().find_map(|item| {
                item.get("content")?.as_array()?.iter().find_map(|content| {
                    (content.get("type").and_then(Value::as_str) == Some("output_text"))
                        .then(|| {
                            content
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .flatten()
                })
            })
        })
}

async fn enqueue_worker_call(
    state: &AppState,
    tenant: &Tenant,
    worker_id: &str,
    thread_id: &str,
    name: String,
    arguments: Value,
) -> Result<String, ApiError> {
    let call_id = Uuid::new_v4().to_string();
    let arguments_json = serde_json::to_string(&arguments).map_err(ApiError::internal)?;
    let worker_id = worker_id.to_owned();
    let thread_id = thread_id.to_owned();
    let id = call_id.clone();
    tenant_db(state, tenant, false, move |connection| {
        connection.execute(
            "INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at) VALUES(?,?,?,?,?,'queued',?)",
            params![id, worker_id, thread_id, name, arguments_json, now()],
        )?;
        Ok(())
    })
    .await?;
    Ok(call_id)
}

async fn wait_worker_result(
    state: &AppState,
    tenant: &Tenant,
    call_id: &str,
) -> Result<Value, ApiError> {
    let call_id = call_id.to_owned();
    for _ in 0..WORKER_RESULT_TIMEOUT_SECONDS {
        let id = call_id.clone();
        let value = tenant_db(state, tenant, false, move |connection| {
            connection
                .query_row(
                    "SELECT status,result_json FROM worker_calls WHERE id=?",
                    [id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .optional()
                .map_err(Into::into)
        })
        .await?
        .ok_or_else(|| ApiError::not_found("Worker call not found"))?;
        match value.0.as_str() {
            "completed" => {
                return value
                    .1
                    .and_then(|result| serde_json::from_str(&result).ok())
                    .ok_or_else(|| ApiError::unavailable("Worker returned invalid output"));
            }
            "failed" => {
                return Err(ApiError::unavailable("Worker tool call failed"));
            }
            _ => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    Err(ApiError::unavailable("Worker tool call timed out"))
}

fn parse_api_key(value: &str) -> Result<(String, String), ApiError> {
    let mut parts = value.splitn(3, '_');
    let prefix = parts.next();
    let tenant_id = parts.next();
    let secret = parts.next();
    match (prefix, tenant_id, secret) {
        (Some("cyb"), Some(tenant_id), Some(secret)) if !secret.is_empty() => {
            Ok((tenant_id.to_owned(), secret.to_owned()))
        }
        _ => Err(ApiError::unauthorized("invalid API key")),
    }
}

async fn api_identity(state: &AppState, headers: &HeaderMap) -> Result<ApiIdentity, ApiError> {
    let raw_key = bearer(headers)?;
    let (tenant_id, secret) = parse_api_key(&raw_key)?;
    let tenant = tenant_from_id(state, tenant_id)?;
    let secret_hash = hash_secret(&secret);
    tenant_db(state, &tenant, false, move |connection| {
        let key_id: Option<String> = connection
            .query_row(
                "SELECT id FROM api_keys WHERE secret_hash=? AND revoked_at IS NULL",
                [secret_hash],
                |row| row.get(0),
            )
            .optional()?;
        let Some(key_id) = key_id else {
            return Err(ApiError::unauthorized("invalid API key"));
        };
        connection.execute(
            "UPDATE api_keys SET last_used_at=? WHERE id=?",
            params![now(), key_id],
        )?;
        Ok(())
    })
    .await?;
    Ok(ApiIdentity { tenant })
}

async fn api_key_auth(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    match api_identity(&state, request.headers()).await {
        Ok(identity) => {
            request.extensions_mut().insert(identity);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

async fn external_create_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<ApiIdentity>,
    Json(input): Json<CreateThreadInput>,
) -> Result<Json<ThreadView>, ApiError> {
    Ok(Json(
        create_thread_for(&state, &identity.tenant, input).await?,
    ))
}

async fn external_read_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<ApiIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ThreadView>, ApiError> {
    Ok(Json(
        read_thread_for(&state, &identity.tenant, thread_id(&id)?).await?,
    ))
}

async fn external_thread_history(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<ApiIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Vec<HistoryRecord>>, ApiError> {
    Ok(Json(
        history_for(&state, &identity.tenant, thread_id(&id)?).await?,
    ))
}

async fn external_thread_input(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<ApiIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<TurnInput>,
) -> Result<Json<RunView>, ApiError> {
    let id = thread_id(&id)?;
    let input = input_text(input.input)?;
    required_integrations(&state, &identity.tenant).await?;
    Ok(Json(enqueue_turn(state, identity.tenant, id, input).await?))
}

async fn worker_identity(
    state: &AppState,
    headers: &HeaderMap,
    tenant_id: String,
    worker_id: String,
) -> Result<Tenant, ApiError> {
    let tenant = tenant_from_id(state, tenant_id)?;
    let worker_id = record_id(&worker_id)?;
    let token_hash = hash_secret(&bearer(headers)?);
    tenant_db(state, &tenant, false, move |connection| {
        let valid: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM workers WHERE id=? AND token_hash=?",
                params![worker_id, token_hash],
                |row| row.get(0),
            )
            .optional()?;
        valid
            .is_some()
            .then_some(())
            .ok_or_else(|| ApiError::unauthorized("invalid Worker credential"))
    })
    .await?;
    Ok(tenant)
}

fn claim_worker_call(
    connection: &mut Connection,
    worker_id: &str,
) -> Result<Option<WorkerCall>, ApiError> {
    let transaction = connection.transaction()?;
    let call: Option<(String, String, String, String)> = transaction
        .query_row(
            "SELECT id,thread_id,name,arguments_json FROM worker_calls WHERE worker_id=? AND status='queued' ORDER BY created_at LIMIT 1",
            [worker_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((id, thread_id, name, arguments_json)) = call else {
        transaction.commit()?;
        return Ok(None);
    };
    transaction.execute(
        "UPDATE worker_calls SET status='delivered' WHERE id=? AND status='queued'",
        [&id],
    )?;
    transaction.commit()?;
    let arguments = serde_json::from_str(&arguments_json)
        .map_err(|_| ApiError::internal("stored Worker arguments are invalid"))?;
    Ok(Some(WorkerCall {
        id,
        thread_id,
        name,
        arguments,
    }))
}

async fn worker_events(
    State(state): State<AppState>,
    AxumPath((tenant_id, worker_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let tenant = worker_identity(&state, &headers, tenant_id, worker_id.clone()).await?;
    let worker_id = record_id(&worker_id)?;
    let event_state = state.clone();
    let stream = async_stream::stream! {
        loop {
            let worker_id = worker_id.clone();
            match tenant_db(&event_state, &tenant, false, move |connection| claim_worker_call(connection, &worker_id)).await {
                Ok(Some(call)) => {
                    let payload = json!({
                        "id": call.id,
                        "thread_id": call.thread_id,
                        "name": call.name,
                        "arguments": call.arguments,
                    });
                    yield Ok(Event::default().event("tool_call").data(payload.to_string()));
                }
                Ok(None) => yield Ok(Event::default().event("heartbeat").data("{}")),
                Err(error) => {
                    tracing::warn!(error = %error.message, "Worker event stream ended");
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
}

async fn worker_heartbeat(
    State(state): State<AppState>,
    AxumPath((tenant_id, worker_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<WorkerHeartbeat>,
) -> Result<Json<Value>, ApiError> {
    let _reported_runtime = (input.hostname, input.version);
    let tenant = worker_identity(&state, &headers, tenant_id, worker_id.clone()).await?;
    let worker_id = record_id(&worker_id)?;
    tenant_db(&state, &tenant, false, move |connection| {
        connection.execute(
            "UPDATE workers SET status='online',last_seen_at=? WHERE id=?",
            params![now(), worker_id],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}

async fn worker_resources(
    State(state): State<AppState>,
    AxumPath((tenant_id, worker_id)): AxumPath<(String, String)>,
    headers: HeaderMap,
    Json(resource): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let tenant = worker_identity(&state, &headers, tenant_id, worker_id.clone()).await?;
    let worker_id = record_id(&worker_id)?;
    let resource = serde_json::to_string(&resource).map_err(ApiError::internal)?;
    tenant_db(&state, &tenant, false, move |connection| {
        connection.execute(
            "UPDATE workers SET status='online',last_seen_at=?,resource_json=? WHERE id=?",
            params![now(), resource, worker_id],
        )?;
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}

async fn worker_result(
    State(state): State<AppState>,
    AxumPath((tenant_id, worker_id, call_id)): AxumPath<(String, String, String)>,
    headers: HeaderMap,
    Json(input): Json<WorkerResultInput>,
) -> Result<Json<Value>, ApiError> {
    let tenant = worker_identity(&state, &headers, tenant_id, worker_id.clone()).await?;
    let worker_id = record_id(&worker_id)?;
    let call_id = record_id(&call_id)?;
    let result = serde_json::to_string(&input.result).map_err(ApiError::internal)?;
    let status = if input.failed { "failed" } else { "completed" };
    tenant_db(&state, &tenant, false, move |connection| {
        let changed = connection.execute(
            "UPDATE worker_calls SET status=?,result_json=?,completed_at=? WHERE id=? AND worker_id=? AND status IN ('queued','delivered')",
            params![status, result, now(), call_id, worker_id],
        )?;
        if changed == 0 {
            return Err(ApiError::not_found("Worker call not found"));
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> (tempfile::TempDir, AppState) {
        let root = tempfile::tempdir().unwrap();
        prepare_data_dir(root.path()).unwrap();
        let data_dir = root.path().to_path_buf();
        (
            root,
            AppState {
                data_dir: Arc::new(data_dir),
                client: reqwest::Client::new(),
                auth: Arc::new(OnceCell::new()),
                integration_locks: Arc::new(Mutex::new(HashMap::new())),
            },
        )
    }

    #[test]
    fn tenant_id_is_stable_and_never_contains_the_subject() {
        let first = tenant_id("auth-mini-subject");
        assert_eq!(first, tenant_id("auth-mini-subject"));
        assert_ne!(first, tenant_id("another-subject"));
        assert_eq!(first.len(), 64);
        assert!(!first.contains("subject"));
    }

    #[tokio::test]
    async fn tenant_threads_are_physically_isolated() {
        let (_root, state) = test_state();
        let first = tenant_for_subject(&state, "first-user");
        let second = tenant_for_subject(&state, "second-user");
        let created = create_thread_for(
            &state,
            &first,
            CreateThreadInput {
                title: Some("Private thread".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(list_threads_for(&state, &first).await.unwrap().len(), 1);
        assert!(list_threads_for(&state, &second).await.unwrap().is_empty());
        assert_ne!(first.path, second.path);
        assert!(first.path.is_file());
        assert!(second.path.is_file());
        assert!(read_thread_for(&state, &second, created.id).await.is_err());
    }

    #[tokio::test]
    async fn failed_runs_leave_a_terminal_run_and_thread_state() {
        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "failed-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Failure test".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        let run = RunView {
            id: Uuid::new_v4().to_string(),
            thread_id: thread.id.clone(),
            status: "queued".to_owned(),
            error: None,
            started_at: now(),
            finished_at: None,
        };
        tenant_db(&state, &tenant, true, {
            let run = run.clone();
            move |connection| {
                connection.execute(
                    "INSERT INTO thread_runs(id,thread_id,status,started_at) VALUES(?,?,?,?)",
                    params![run.id, run.thread_id, run.status, run.started_at],
                )?;
                connection.execute(
                    "UPDATE threads SET status='running' WHERE id=?",
                    [&run.thread_id],
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        assert!(fail_run(&state, &tenant, &run, "upstream unavailable").await);
        let stored = tenant_db(&state, &tenant, false, {
            let run_id = run.id.clone();
            let thread_id = run.thread_id.clone();
            move |connection| {
                let run_status: String = connection.query_row(
                    "SELECT status FROM thread_runs WHERE id=?",
                    [&run_id],
                    |row| row.get(0),
                )?;
                let thread_status: String = connection.query_row(
                    "SELECT status FROM threads WHERE id=?",
                    [&thread_id],
                    |row| row.get(0),
                )?;
                let history: String = connection.query_row(
                    "SELECT content FROM history_records WHERE thread_id=? ORDER BY id DESC LIMIT 1",
                    [&thread_id],
                    |row| row.get(0),
                )?;
                Ok((run_status, thread_status, history))
            }
        })
        .await
        .unwrap();
        assert_eq!(stored.0, "failed");
        assert_eq!(stored.1, "failed");
        assert!(stored.2.contains("upstream unavailable"));
    }

    #[tokio::test]
    async fn history_is_available_to_external_api_callers() {
        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "history-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("History test".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        tenant_db(&state, &tenant, true, {
            let thread_id = thread.id.clone();
            move |connection| {
                connection.execute(
                    "INSERT INTO history_records(thread_id,role,content,created_at) VALUES(?,'assistant','done',?)",
                    params![thread_id, now()],
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        let records = history_for(&state, &tenant, thread.id).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].content, "done");
    }

    #[test]
    fn external_key_keeps_its_tenant_route_segment() {
        let tenant = "a".repeat(64);
        assert_eq!(
            parse_api_key(&format!("cyb_{tenant}_one_two")).unwrap(),
            (tenant, "one_two".to_owned())
        );
        assert!(parse_api_key("sk-not-a-cybion-key").is_err());
    }
}
