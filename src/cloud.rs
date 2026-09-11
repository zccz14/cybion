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
    extract::{Path as AxumPath, Query, Request, State},
    http::{HeaderMap, StatusCode, Uri, header},
    middleware::{Next, from_fn_with_state},
    response::{
        IntoResponse, Response,
        sse::{Event, Sse},
    },
    routing::{delete, get, post},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
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
const MAX_CONTEXT_TOOL_OUTPUT_CHARS: usize = 65_536;
const TOOL_OUTPUT_TRUNCATED_NOTICE: &str = "\n内容过长已经截断";
const CHECKPOINT_SUMMARY_INPUT_BYTES: usize = 48 * 1024;
const CHECKPOINT_SUMMARY_MAX_OUTPUT_TOKENS: usize = 4_096;
const CHECKPOINT_SUMMARY_MAX_ROUNDS: usize = 8;
const CHECKPOINT_RETRY_LIMIT: usize = 2;

// The browser bearer is minted for all three resource hosts. Cybion forwards
// that ordinary Auth Mini token only to each service's existing user API; no
// downstream service receives Cybion-specific context.

#[derive(Clone)]
struct AppState {
    data_dir: Arc<PathBuf>,
    client: reqwest::Client,
    auth: Arc<OnceCell<AuthMiniLayer>>,
    integration_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    thread_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
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
    kind: ApiErrorKind,
}

#[derive(Debug, PartialEq, Eq)]
enum ApiErrorKind {
    Ordinary,
    ContextOverflow,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn context_overflow(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
            kind: ApiErrorKind::ContextOverflow,
        }
    }

    fn internal(cause: impl std::fmt::Display) -> Self {
        tracing::error!(%cause, "Cybion request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Cybion could not complete the request".to_owned(),
            kind: ApiErrorKind::Ordinary,
        }
    }

    fn is_context_overflow(&self) -> bool {
        self.kind == ApiErrorKind::ContextOverflow
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
    recover_interrupted_turns(&data_dir)?;
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
        thread_locks: Arc::new(Mutex::new(HashMap::new())),
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

fn recover_interrupted_turns(data_dir: &Path) -> Result<()> {
    for entry in fs::read_dir(data_dir.join("tenants"))? {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite3") {
            continue;
        }
        let mut connection = Connection::open(&path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        connection.execute_batch(TENANT_SCHEMA)?;
        migrate_tenant_history(&mut connection).map_err(|error| anyhow::anyhow!(error.message))?;
        connection.execute_batch(TENANT_HISTORY_INDEXES)?;
        let interrupted = {
            let mut statement = connection.prepare(
                "SELECT id,thread_id,turn_index FROM thread_runs
                 WHERE status IN ('queued','running') ORDER BY thread_id,turn_index",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if interrupted.is_empty() {
            continue;
        }
        let finished_at = now();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (run_id, thread_id, turn_index) in interrupted {
            let content = "Run interrupted by a Cybion restart";
            transaction.execute(
                "INSERT INTO history_records(thread_id,run_id,turn_index,role,content,kind,payload,visible,created_at)
                 VALUES(?,?,?,?,?,'activity',?,1,?)",
                params![
                    &thread_id,
                    &run_id,
                    turn_index,
                    "system",
                    content,
                    serde_json::to_string(&json!({"role":"system","content":content}))?,
                    finished_at,
                ],
            )?;
            transaction.execute(
                "UPDATE thread_runs SET status='failed',error=?,finished_at=? WHERE id=?",
                params![content, finished_at, &run_id],
            )?;
            transaction.execute(
                "UPDATE reasoning_audits SET status='failed',error=?,finished_at=? WHERE run_id=?",
                params![content, finished_at, &run_id],
            )?;
            transaction.execute(
                "UPDATE threads SET status='failed',updated_at=? WHERE id=?",
                params![finished_at, &thread_id],
            )?;
        }
        transaction.commit()?;
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
        .route("/api/reasoning-audits", get(reasoning_audits))
        .route("/api/system/resources", get(system_resources))
        .route("/api/status", get(status))
        .route("/api/integrations", get(integrations))
        .route("/api/integrations/refresh", post(refresh_integrations))
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
    let mut connection = Connection::open(path).map_err(ApiError::internal)?;
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
    migrate_tenant_history(&mut connection)?;
    connection
        .execute_batch(TENANT_HISTORY_INDEXES)
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
  run_id TEXT,
  turn_index INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'input' CHECK(kind IN ('input','response_output','tool_output','checkpoint','activity')),
  payload TEXT NOT NULL DEFAULT '{}',
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_records_thread_created ON history_records(thread_id,id);
CREATE TABLE IF NOT EXISTS thread_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS thread_runs_thread_started ON thread_runs(thread_id,started_at DESC);
CREATE TABLE IF NOT EXISTS reasoning_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES thread_runs(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  request_kind TEXT NOT NULL DEFAULT 'thread_turn',
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_flight','completed','failed','cancelled')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  openai_lb_request_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS reasoning_audits_status_started ON reasoning_audits(status,started_at DESC);
CREATE INDEX IF NOT EXISTS reasoning_audits_thread_started ON reasoning_audits(thread_id,started_at DESC);
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

const TENANT_HISTORY_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS history_records_thread_kind_created
  ON history_records(thread_id,kind,id);
CREATE INDEX IF NOT EXISTS history_records_thread_run_created
  ON history_records(thread_id,run_id,id);
CREATE INDEX IF NOT EXISTS history_records_thread_turn_created
  ON history_records(thread_id,turn_index,id);
CREATE INDEX IF NOT EXISTS thread_runs_thread_turn
  ON thread_runs(thread_id,turn_index);
CREATE UNIQUE INDEX IF NOT EXISTS thread_runs_thread_turn_unique
  ON thread_runs(thread_id,turn_index);
"#;

fn table_columns(connection: &Connection, table: &str) -> Result<Vec<String>, ApiError> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(ApiError::internal)?;
    let rows = statement
        .query_map([], |row| row.get(1))
        .map_err(ApiError::internal)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(ApiError::internal)
}

fn migrate_tenant_history(connection: &mut Connection) -> Result<(), ApiError> {
    let history_columns = table_columns(connection, "history_records")?;
    if !history_columns.iter().any(|column| column == "run_id") {
        connection
            .execute_batch("ALTER TABLE history_records ADD COLUMN run_id TEXT")
            .map_err(ApiError::internal)?;
    }
    if !history_columns.iter().any(|column| column == "kind") {
        connection
            .execute_batch(
                "ALTER TABLE history_records ADD COLUMN kind TEXT NOT NULL DEFAULT 'input'",
            )
            .map_err(ApiError::internal)?;
    }
    if !history_columns.iter().any(|column| column == "payload") {
        connection
            .execute_batch(
                "ALTER TABLE history_records ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'",
            )
            .map_err(ApiError::internal)?;
    }
    if !history_columns.iter().any(|column| column == "visible") {
        connection
            .execute_batch(
                "ALTER TABLE history_records ADD COLUMN visible INTEGER NOT NULL DEFAULT 1",
            )
            .map_err(ApiError::internal)?;
    }

    if !history_columns.iter().any(|column| column == "turn_index") {
        connection
            .execute_batch(
                "ALTER TABLE history_records ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0",
            )
            .map_err(ApiError::internal)?;
    }
    let run_columns = table_columns(connection, "thread_runs")?;
    if !run_columns.iter().any(|column| column == "turn_index") {
        connection
            .execute_batch(
                "ALTER TABLE thread_runs ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0",
            )
            .map_err(ApiError::internal)?;
    }

    let legacy = {
        let mut statement = connection
            .prepare("SELECT id,role,content FROM history_records WHERE payload='{}'")
            .map_err(ApiError::internal)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(ApiError::internal)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(ApiError::internal)?
    };
    let transaction = connection.transaction().map_err(ApiError::internal)?;
    for (id, role, content) in legacy {
        let (kind, payload) = match role.as_str() {
            "user" => ("input", json!({"role":"user","content":content})),
            "assistant" => (
                "response_output",
                json!({
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":content}],
                }),
            ),
            "tool" => ("activity", json!({"role":"tool","content":content})),
            _ => ("activity", json!({"role":"system","content":content})),
        };
        transaction
            .execute(
                "UPDATE history_records SET kind=?,payload=? WHERE id=?",
                params![
                    kind,
                    serde_json::to_string(&payload).map_err(ApiError::internal)?,
                    id
                ],
            )
            .map_err(ApiError::internal)?;
    }
    let runs = {
        let mut statement = transaction
            .prepare("SELECT id,thread_id FROM thread_runs ORDER BY thread_id,started_at,id")
            .map_err(ApiError::internal)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(ApiError::internal)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(ApiError::internal)?
    };
    let mut next_turn_index = HashMap::new();
    for (run_id, thread_id) in runs {
        let turn_index = next_turn_index.entry(thread_id).or_insert(0_i64);
        *turn_index += 1;
        transaction
            .execute(
                "UPDATE thread_runs SET turn_index=? WHERE id=? AND turn_index=0",
                params![*turn_index, run_id],
            )
            .map_err(ApiError::internal)?;
    }
    transaction.commit().map_err(ApiError::internal)
}

// Route implementations live below the persistence model so the tenant boundary
// remains explicit in every read and write.

#[derive(Clone, Debug, Serialize)]
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
    #[serde(skip_serializing)]
    turn_index: i64,
    status: String,
    error: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
}

#[derive(Clone, Serialize)]
struct ReasoningAuditView {
    id: i64,
    run_id: String,
    thread_id: String,
    thread_title: String,
    request_kind: String,
    model: String,
    status: String,
    started_at: i64,
    finished_at: Option<i64>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cached_tokens: Option<i64>,
    openai_lb_request_id: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Default)]
struct ReasoningAuditQuery {
    page: Option<usize>,
    page_size: Option<usize>,
    status: Option<String>,
    thread_id: Option<String>,
    model: Option<String>,
}

#[derive(Serialize)]
struct ReasoningAuditPage {
    items: Vec<ReasoningAuditView>,
    total: usize,
    page: usize,
    page_size: usize,
}

#[derive(Serialize)]
struct IntegrationStatusView {
    openai_configured: bool,
    openai_consumer_id: Option<String>,
    openai_base_url: String,
    linkit_configured: bool,
    linkit_bot_id: Option<String>,
    linkit_username: Option<String>,
}

#[derive(Serialize)]
struct SystemResourcesView {
    generated_at: i64,
    version: &'static str,
    process_id: u32,
    tenant_id: String,
    database_bytes: u64,
    threads: usize,
    active_runs: usize,
    workers: usize,
    online_workers: usize,
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
struct LinkitMyInfo {
    id: String,
    #[serde(default)]
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

async fn status(
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "hosted": true,
        "version": env!("CARGO_PKG_VERSION"),
        "tenant_id": identity.tenant.id,
    })))
}

fn integration_status_view(settings: &IntegrationSettings) -> IntegrationStatusView {
    IntegrationStatusView {
        openai_configured: !settings.openai_consumer_secret.is_empty(),
        openai_consumer_id: (!settings.openai_consumer_id.is_empty())
            .then(|| settings.openai_consumer_id.clone()),
        openai_base_url: settings.openai_base_url.clone(),
        linkit_configured: !settings.linkit_bot_token.is_empty()
            && !settings.linkit_username.is_empty(),
        linkit_bot_id: (!settings.linkit_bot_id.is_empty()).then(|| settings.linkit_bot_id.clone()),
        linkit_username: (!settings.linkit_username.is_empty())
            .then(|| settings.linkit_username.clone()),
    }
}

async fn integrations(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<IntegrationStatusView>, ApiError> {
    let settings = tenant_db(&state, &identity.tenant, true, |connection| {
        integration_settings(connection)
    })
    .await?;
    Ok(Json(integration_status_view(&settings)))
}

async fn refresh_integrations(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<IntegrationStatusView>, ApiError> {
    let settings = ensure_integrations(&state, &identity.tenant, &identity.bearer).await?;
    Ok(Json(integration_status_view(&settings)))
}

async fn system_resources(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<SystemResourcesView>, ApiError> {
    let database_path = identity.tenant.path.clone();
    let tenant_id = identity.tenant.id.clone();
    tenant_db(&state, &identity.tenant, true, move |connection| {
        let threads: i64 =
            connection.query_row("SELECT COUNT(*) FROM threads", [], |row| row.get(0))?;
        let active_runs: i64 = connection.query_row(
            "SELECT COUNT(*) FROM thread_runs WHERE status IN ('queued','running')",
            [],
            |row| row.get(0),
        )?;
        let workers: i64 =
            connection.query_row("SELECT COUNT(*) FROM workers", [], |row| row.get(0))?;
        let online_workers: i64 = connection.query_row(
            "SELECT COUNT(*) FROM workers WHERE status='online' AND last_seen_at>=?",
            [now() - WORKER_ONLINE_SECONDS],
            |row| row.get(0),
        )?;
        Ok(SystemResourcesView {
            generated_at: now(),
            version: env!("CARGO_PKG_VERSION"),
            process_id: std::process::id(),
            tenant_id,
            database_bytes: fs::metadata(database_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
            threads: threads.max(0) as usize,
            active_runs: active_runs.max(0) as usize,
            workers: workers.max(0) as usize,
            online_workers: online_workers.max(0) as usize,
        })
    })
    .await
    .map(Json)
}

async fn reasoning_audits(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Query(query): Query<ReasoningAuditQuery>,
) -> Result<Json<ReasoningAuditPage>, ApiError> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100);
    let status = query.status.filter(|value| !value.trim().is_empty());
    if let Some(value) = status.as_deref()
        && !matches!(value, "in_flight" | "completed" | "failed" | "cancelled")
    {
        return Err(ApiError::bad_request("invalid reasoning audit status"));
    }
    let thread_id = query.thread_id.filter(|value| !value.trim().is_empty());
    let model = query.model.filter(|value| !value.trim().is_empty());
    tenant_db(&state, &identity.tenant, true, move |connection| {
        let mut statement = connection.prepare(
            "SELECT a.id,a.run_id,a.thread_id,COALESCE(t.title,''),a.request_kind,a.model,a.status,a.started_at,a.finished_at,a.input_tokens,a.output_tokens,a.cached_tokens,a.openai_lb_request_id,a.error
             FROM reasoning_audits a LEFT JOIN threads t ON t.id=a.thread_id ORDER BY a.started_at DESC,a.id DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ReasoningAuditView {
                id: row.get(0)?,
                run_id: row.get(1)?,
                thread_id: row.get(2)?,
                thread_title: row.get(3)?,
                request_kind: row.get(4)?,
                model: row.get(5)?,
                status: row.get(6)?,
                started_at: row.get(7)?,
                finished_at: row.get(8)?,
                input_tokens: row.get(9)?,
                output_tokens: row.get(10)?,
                cached_tokens: row.get(11)?,
                openai_lb_request_id: row.get(12)?,
                error: row.get(13)?,
            })
        })?;
        let mut items = Vec::new();
        for row in rows {
            let item = row?;
            let status_matches = status
                .as_deref()
                .map(|value| value == item.status)
                .unwrap_or(true);
            let thread_matches = thread_id
                .as_deref()
                .map(|value| value == item.thread_id)
                .unwrap_or(true);
            let model_matches = model
                .as_deref()
                .map(|value| value == item.model)
                .unwrap_or(true);
            if status_matches && thread_matches && model_matches {
                items.push(item);
            }
        }
        let total = items.len();
        let start = (page - 1).saturating_mul(page_size);
        let items = items.into_iter().skip(start).take(page_size).collect();
        Ok(ReasoningAuditPage {
            items,
            total,
            page,
            page_size,
        })
    })
    .await
    .map(Json)
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
            "SELECT id,thread_id,role,content,created_at
             FROM history_records WHERE thread_id=? AND visible=1 ORDER BY id",
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
        .json::<LinkitMyInfo>()
        .await?;
    let _linkit_user_id = profile.id;
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

async fn thread_execution_lock(
    state: &AppState,
    tenant: &Tenant,
    thread_id: &str,
) -> Arc<Mutex<()>> {
    let key = format!("{}:{thread_id}", tenant.id);
    let mut locks = state.thread_locks.lock().await;
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn prior_turn_is_active(
    state: &AppState,
    tenant: &Tenant,
    run: &RunView,
) -> Result<bool, ApiError> {
    let thread_id = run.thread_id.clone();
    let turn_index = run.turn_index;
    tenant_db(state, tenant, false, move |connection| {
        connection
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM thread_runs
                   WHERE thread_id=? AND turn_index<? AND status IN ('queued','running')
                 )",
                params![thread_id, turn_index],
                |row| row.get(0),
            )
            .map_err(Into::into)
    })
    .await
}

struct HistoryRecordInsert<'a> {
    thread_id: &'a str,
    run_id: Option<&'a str>,
    turn_index: i64,
    role: &'a str,
    content: &'a str,
    kind: &'a str,
    payload: &'a Value,
    visible: bool,
    created_at: i64,
}

fn persist_history_record(
    connection: &Connection,
    record: HistoryRecordInsert<'_>,
) -> Result<i64, ApiError> {
    connection.execute(
        "INSERT INTO history_records(thread_id,run_id,turn_index,role,content,kind,payload,visible,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)",
        params![
            record.thread_id,
            record.run_id,
            record.turn_index,
            record.role,
            record.content,
            record.kind,
            serde_json::to_string(record.payload).map_err(ApiError::internal)?,
            if record.visible { 1 } else { 0 },
            record.created_at,
        ],
    )?;
    Ok(connection.last_insert_rowid())
}

#[derive(Debug)]
struct CompiledThreadContext {
    items: Vec<Value>,
    current_turn_tail_id: i64,
}

fn compile_thread_context(
    connection: &Connection,
    thread_id: &str,
    turn_index: i64,
) -> Result<CompiledThreadContext, ApiError> {
    let current_turn_tail_id = connection
        .query_row(
            "SELECT MAX(id) FROM history_records WHERE thread_id=? AND turn_index=?",
            params![thread_id, turn_index],
            |row| row.get::<_, Option<i64>>(0),
        )?
        .ok_or_else(|| ApiError::conflict("thread run has no durable history"))?;
    let checkpoint = connection
        .query_row(
            "SELECT id,turn_index,payload FROM history_records
             WHERE thread_id=? AND kind='checkpoint' AND turn_index<=?
             ORDER BY turn_index DESC,id DESC LIMIT 1",
            params![thread_id, turn_index],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let mut items = Vec::new();
    if let Some((checkpoint_id, checkpoint_turn_index, payload)) = checkpoint {
        let checkpoint = serde_json::from_str::<Value>(&payload).map_err(ApiError::internal)?;
        items.push(context_protocol_item(&checkpoint));
        let mut statement = connection.prepare(
            "SELECT payload FROM history_records
             WHERE thread_id=?1
               AND kind IN ('input','response_output','tool_output')
               AND turn_index<=?2
               AND (turn_index>?3 OR (turn_index=?3 AND id>?4))
             ORDER BY turn_index,id",
        )?;
        let mut rows = statement.query(params![
            thread_id,
            turn_index,
            checkpoint_turn_index,
            checkpoint_id,
        ])?;
        while let Some(row) = rows.next()? {
            let payload: String = row.get(0)?;
            let item = serde_json::from_str::<Value>(&payload).map_err(ApiError::internal)?;
            items.push(context_protocol_item(&item));
        }
    } else {
        let mut statement = connection.prepare(
            "SELECT payload FROM history_records
             WHERE thread_id=? AND kind IN ('input','response_output','tool_output') AND turn_index<=?
             ORDER BY turn_index,id",
        )?;
        let mut rows = statement.query(params![thread_id, turn_index])?;
        while let Some(row) = rows.next()? {
            let payload: String = row.get(0)?;
            let item = serde_json::from_str::<Value>(&payload).map_err(ApiError::internal)?;
            items.push(context_protocol_item(&item));
        }
    }
    (!items.is_empty())
        .then_some(CompiledThreadContext {
            items,
            current_turn_tail_id,
        })
        .ok_or_else(|| ApiError::conflict("thread run has no replayable history"))
}

fn context_protocol_item(item: &Value) -> Value {
    let mut item = item.clone();
    match item.get("type").and_then(Value::as_str) {
        Some("function_call_output") => {
            if let Some(output) = item.get("output").and_then(Value::as_str) {
                item["output"] = Value::String(context_tool_output(output));
            }
        }
        Some("web_search_call") => {
            // COMPATIBILITY: OpenAI LB rejects `action` on replayed web-search output.
            // Remove this once stateless replay accepts the raw upstream item.
            item.as_object_mut()
                .expect("typed Responses item is an object")
                .remove("action");
        }
        Some("image_generation_call") => {
            // COMPATIBILITY: OpenAI LB rejects `action` and native `size` on replayed images.
            // Remove this once stateless replay accepts the raw upstream item.
            let image = item
                .as_object_mut()
                .expect("typed Responses item is an object");
            image.remove("action");
            image.remove("size");
        }
        _ => {}
    }
    item
}

fn context_tool_output(output: &str) -> String {
    let Some((end, _)) = output.char_indices().nth(MAX_CONTEXT_TOOL_OUTPUT_CHARS) else {
        return output.to_owned();
    };
    format!("{}{}", &output[..end], TOOL_OUTPUT_TRUNCATED_NOTICE)
}

async fn enqueue_turn(
    state: AppState,
    tenant: Tenant,
    thread_id: String,
    input: String,
) -> Result<RunView, ApiError> {
    let run_id = Uuid::new_v4().to_string();
    let started_at = now();
    let queued_id = run_id.clone();
    let queued_thread_id = thread_id.clone();
    let input_payload = json!({"role":"user","content":input});
    let turn_index = tenant_db(&state, &tenant, true, move |connection| {
        let thread = load_thread(connection, &queued_thread_id)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let turn_index = transaction.query_row(
            "SELECT COALESCE(MAX(turn_index),0)+1 FROM thread_runs WHERE thread_id=?",
            [&queued_thread_id],
            |row| row.get::<_, i64>(0),
        )?;
        persist_history_record(
            &transaction,
            HistoryRecordInsert {
                thread_id: &queued_thread_id,
                run_id: Some(&queued_id),
                turn_index,
                role: "user",
                content: input_payload
                    .get("content")
                    .and_then(Value::as_str)
                    .expect("validated input is a string"),
                kind: "input",
                payload: &input_payload,
                visible: true,
                created_at: started_at,
            },
        )?;
        transaction.execute(
            "INSERT INTO thread_runs(id,thread_id,turn_index,status,started_at) VALUES(?,?,?,'queued',?)",
            params![&queued_id, &queued_thread_id, turn_index, started_at],
        )?;
        transaction.execute(
            "INSERT INTO reasoning_audits(run_id,thread_id,request_kind,model,status,started_at) VALUES(?,?,? ,?,?,?)",
            params![
                &queued_id,
                &queued_thread_id,
                "thread_turn",
                &thread.model,
                "in_flight",
                started_at
            ],
        )?;
        transaction.execute(
            "UPDATE threads SET status='running',updated_at=? WHERE id=?",
            params![started_at, &queued_thread_id],
        )?;
        transaction.commit()?;
        Ok(turn_index)
    })
    .await?;
    let run = RunView {
        id: run_id,
        thread_id,
        turn_index,
        status: "queued".to_owned(),
        error: None,
        started_at,
        finished_at: None,
    };
    let pending = run.clone();
    let background_state = state.clone();
    tokio::spawn(async move {
        execute_turn(background_state, tenant, run).await;
    });
    Ok(pending)
}

async fn execute_turn(state: AppState, tenant: Tenant, run: RunView) {
    let execution_lock = thread_execution_lock(&state, &tenant, &run.thread_id).await;
    let execution_guard = loop {
        let guard = execution_lock.lock().await;
        match prior_turn_is_active(&state, &tenant, &run).await {
            Ok(false) => break guard,
            Ok(true) => {
                drop(guard);
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => {
                drop(guard);
                tracing::warn!(run_id = %run.id, error = %error.message, "could not order a thread run");
                fail_run(&state, &tenant, &run, &error.message).await;
                return;
            }
        }
    };
    let _ = tenant_db(&state, &tenant, false, {
        let run = run.clone();
        move |connection| {
            connection.execute(
                "UPDATE thread_runs SET status='running' WHERE id=? AND status='queued'",
                [&run.id],
            )?;
            connection.execute(
                "UPDATE reasoning_audits SET status='in_flight' WHERE run_id=?",
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
            let worker: Option<String> = connection
                .query_row(
                    "SELECT id FROM workers WHERE status='online' AND last_seen_at>=? ORDER BY last_seen_at DESC LIMIT 1",
                    [now() - WORKER_ONLINE_SECONDS],
                    |row| row.get(0),
                )
                .optional()?;
            Ok((thread, integrations, worker))
        }
    })
    .await;
    let result = match context {
        Ok((thread, integrations, worker)) if integrations_ready(&integrations) => {
            run_agent(&state, &tenant, &thread, &integrations, worker, &run).await
        }
        Ok((thread, _, _)) => Err((
            thread,
            Box::new(ApiError::conflict("tenant integrations are not ready")),
        )),
        Err(error) => {
            tracing::warn!(run_id = %run.id, error = %error.message, "could not load a thread run");
            fail_run(&state, &tenant, &run, &error.message).await;
            drop(execution_guard);
            return;
        }
    };
    match result {
        Ok((thread, integrations, output)) => {
            let finished_at = now();
            let completed_run_id = run.id.clone();
            let completed_thread_id = run.thread_id.clone();
            if let Err(error) = tenant_db(&state, &tenant, false, move |connection| {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "UPDATE thread_runs SET status='completed',finished_at=?,error=NULL WHERE id=?",
                    params![finished_at, &completed_run_id],
                )?;
                transaction.execute(
                    "UPDATE reasoning_audits SET status='completed',finished_at=?,error=NULL WHERE run_id=?",
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
            drop(execution_guard);
            notify_thread(&state, &integrations, &thread, true, &output).await;
        }
        Err((thread, error)) => {
            let error_text = error.message.clone();
            let finalized = fail_run(&state, &tenant, &run, &error_text).await;
            drop(execution_guard);
            if !finalized {
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
    let failed_turn_index = run.turn_index;
    match tenant_db(state, tenant, false, move |connection| {
        let finished_at = now();
        let transaction = connection.transaction()?;
        let content = format!("Run failed: {error_for_db}");
        persist_history_record(
            &transaction,
            HistoryRecordInsert {
                thread_id: &failed_thread_id,
                run_id: Some(&failed_run_id),
                turn_index: failed_turn_index,
                role: "system",
                content: &content,
                kind: "activity",
                payload: &json!({"role":"system","content":&content}),
                visible: true,
                created_at: finished_at,
            },
        )?;
        transaction.execute(
            "UPDATE thread_runs SET status='failed',error=?,finished_at=? WHERE id=?",
            params![&error_for_db, finished_at, &failed_run_id],
        )?;
        transaction.execute(
            "UPDATE reasoning_audits SET status='failed',error=?,finished_at=? WHERE run_id=?",
            params![&error_for_db, finished_at, &failed_run_id],
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

struct ResponsesResult {
    value: Value,
    request_id: Option<String>,
}

async fn run_agent(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    integrations: &IntegrationSettings,
    worker_id: Option<String>,
    run: &RunView,
) -> Result<(ThreadView, IntegrationSettings, String), (ThreadView, Box<ApiError>)> {
    let mut tool_rounds = 0;
    let mut checkpoint_retries = 0;
    loop {
        if tool_rounds == 8 {
            return Err((
                thread.clone(),
                Box::new(ApiError::unavailable(
                    "agent exceeded the Worker tool-call limit",
                )),
            ));
        }
        let context = tenant_db(state, tenant, false, {
            let thread_id = thread.id.clone();
            let turn_index = run.turn_index;
            move |connection| compile_thread_context(connection, &thread_id, turn_index)
        })
        .await
        .map_err(|error| (thread.clone(), Box::new(error)))?;
        let response = match responses_request(
            state,
            integrations,
            &thread.model,
            Value::Array(context.items.clone()),
            worker_id.is_some(),
            None,
        )
        .await
        {
            Err(error)
                if error.is_context_overflow() && checkpoint_retries < CHECKPOINT_RETRY_LIMIT =>
            {
                checkpoint_retries += 1;
                compact_thread_context(state, tenant, thread, run, &context, integrations)
                    .await
                    .map_err(|error| (thread.clone(), Box::new(error)))?;
                continue;
            }
            Err(error) => return Err((thread.clone(), Box::new(error))),
            Ok(response) => response,
        };
        let ResponsesResult {
            value: response,
            request_id,
        } = response;
        update_reasoning_audit_usage(state, tenant, &run.id, &response, request_id).await;
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| {
                (
                    thread.clone(),
                    Box::new(ApiError::unavailable("model response has no output")),
                )
            })?;
        append_response_output_items(state, tenant, thread, run, &output)
            .await
            .map_err(|error| (thread.clone(), Box::new(error)))?;
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
            let output = json!({
                "type":"function_call_output",
                "call_id":call.call_id,
                "output":result.to_string(),
            });
            append_tool_output_item(state, tenant, thread, run, &output)
                .await
                .map_err(|error| (thread.clone(), Box::new(error)))?;
        }
        tool_rounds += 1;
    }
}

fn output_text(items: &[Value]) -> String {
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|content| content.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .collect()
}

fn response_item_display(item: &Value) -> (String, String, bool) {
    if item.get("type").and_then(Value::as_str) == Some("message") {
        let content = output_text(std::slice::from_ref(item));
        return (
            "assistant".to_owned(),
            content.clone(),
            !content.trim().is_empty(),
        );
    }
    (
        "tool".to_owned(),
        "Responses protocol item recorded".to_owned(),
        false,
    )
}

async fn append_response_output_items(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    run: &RunView,
    output: &[Value],
) -> Result<(), ApiError> {
    let records = output
        .iter()
        .map(|item| {
            let (role, content, visible) = response_item_display(item);
            Ok((
                role,
                content,
                serde_json::to_string(item).map_err(ApiError::internal)?,
                visible,
            ))
        })
        .collect::<std::result::Result<Vec<_>, ApiError>>()?;
    let thread_id = thread.id.clone();
    let run_id = run.id.clone();
    let turn_index = run.turn_index;
    let created_at = now();
    tenant_db(state, tenant, false, move |connection| {
        let transaction = connection.transaction()?;
        for (role, content, payload, visible) in records {
            transaction.execute(
                "INSERT INTO history_records(thread_id,run_id,turn_index,role,content,kind,payload,visible,created_at)
                 VALUES(?,?,?,?,?,'response_output',?,?,?)",
                params![
                    &thread_id,
                    &run_id,
                    turn_index,
                    role,
                    content,
                    payload,
                    if visible { 1 } else { 0 },
                    created_at,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

async fn append_tool_output_item(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    run: &RunView,
    item: &Value,
) -> Result<(), ApiError> {
    let content = item
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| item.to_string());
    let payload = serde_json::to_string(item).map_err(ApiError::internal)?;
    let thread_id = thread.id.clone();
    let run_id = run.id.clone();
    let turn_index = run.turn_index;
    let created_at = now();
    tenant_db(state, tenant, false, move |connection| {
        connection.execute(
            "INSERT INTO history_records(thread_id,run_id,turn_index,role,content,kind,payload,visible,created_at)
             VALUES(?,?,?,?,?,'tool_output',?,0,?)",
            params![
                thread_id,
                run_id,
                turn_index,
                "tool",
                content,
                payload,
                created_at,
            ],
        )?;
        Ok(())
    })
    .await
}

async fn compact_thread_context(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    run: &RunView,
    context: &CompiledThreadContext,
    integrations: &IntegrationSettings,
) -> Result<(), ApiError> {
    let summary =
        summarize_context(state, integrations, &thread.model, context.items.clone()).await?;
    persist_thread_checkpoint(
        state,
        tenant,
        thread,
        run,
        context.current_turn_tail_id,
        summary,
    )
    .await
}

async fn persist_thread_checkpoint(
    state: &AppState,
    tenant: &Tenant,
    thread: &ThreadView,
    run: &RunView,
    current_turn_tail_id: i64,
    summary: String,
) -> Result<(), ApiError> {
    let payload = serde_json::to_string(&json!({"role":"developer","content":summary}))
        .map_err(ApiError::internal)?;
    let thread_id = thread.id.clone();
    let run_id = run.id.clone();
    let turn_index = run.turn_index;
    tenant_db(state, tenant, false, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let latest: Option<i64> = transaction.query_row(
            "SELECT MAX(id) FROM history_records WHERE thread_id=? AND turn_index=?",
            params![&thread_id, turn_index],
            |row| row.get(0),
        )?;
        if latest != Some(current_turn_tail_id) {
            return Err(ApiError::conflict(
                "thread context changed while its checkpoint was being compacted",
            ));
        }
        transaction.execute(
            "INSERT INTO history_records(thread_id,run_id,turn_index,role,content,kind,payload,visible,created_at)
             VALUES(?,?,?,?,?,'checkpoint',?,0,?)",
            params![
                thread_id,
                run_id,
                turn_index,
                "system",
                "Context checkpoint",
                payload,
                now(),
            ],
        )?;
        transaction.commit()?;
        Ok(())
    })
    .await
}

async fn summarize_context(
    state: &AppState,
    integrations: &IntegrationSettings,
    model: &str,
    items: Vec<Value>,
) -> Result<String, ApiError> {
    let mut batches = context_summary_batches(items);
    for _ in 0..CHECKPOINT_SUMMARY_MAX_ROUNDS {
        if batches.len() == 1 {
            return summarize_context_once(
                state,
                integrations,
                model,
                batches.pop().expect("one checkpoint summary batch exists"),
            )
            .await;
        }
        let input_bytes = context_summary_bytes(&batches);
        let mut summaries = Vec::with_capacity(batches.len());
        for batch in batches {
            let summary = summarize_context_once(state, integrations, model, batch).await?;
            summaries.push(json!({"role":"developer","content":summary}));
        }
        if context_summary_bytes(std::slice::from_ref(&summaries)) >= input_bytes {
            return Err(ApiError::unavailable(
                "context checkpoint did not reduce its input",
            ));
        }
        batches = context_summary_batches(summaries);
    }
    Err(ApiError::unavailable(
        "context checkpoint exceeded its reduction limit",
    ))
}

async fn summarize_context_once(
    state: &AppState,
    integrations: &IntegrationSettings,
    model: &str,
    items: Vec<Value>,
) -> Result<String, ApiError> {
    let mut input = Vec::with_capacity(items.len() + 1);
    input.push(json!({"role":"developer","content":checkpoint_developer_prompt()}));
    input.extend(items);
    let response = responses_request(
        state,
        integrations,
        model,
        Value::Array(input),
        false,
        Some(CHECKPOINT_SUMMARY_MAX_OUTPUT_TOKENS),
    )
    .await?;
    response_text(&response.value)
        .filter(|summary| !summary.trim().is_empty())
        .ok_or_else(|| ApiError::unavailable("checkpoint response has no text"))
}

fn checkpoint_developer_prompt() -> &'static str {
    r#"# Thread context checkpoint

Write a compact Markdown state checkpoint for the same thread. It will replace the earlier
replayed protocol history in the next inference request, so preserve only what is needed to
continue correctly: the current objective, verified facts, active constraints, unfinished work,
and the next useful step. Do not answer the user, call tools, invent facts, or retell the full
conversation. Raw history remains durable outside this checkpoint."#
}

fn context_summary_batches(items: Vec<Value>) -> Vec<Vec<Value>> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut bytes = 0;
    for item in items.into_iter().flat_map(context_summary_segments) {
        let item_bytes = serde_json::to_vec(&item)
            .expect("context summary item is serializable")
            .len();
        if !batch.is_empty() && bytes + item_bytes > CHECKPOINT_SUMMARY_INPUT_BYTES {
            batches.push(std::mem::take(&mut batch));
            bytes = 0;
        }
        bytes += item_bytes;
        batch.push(item);
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

fn context_summary_segments(item: Value) -> Vec<Value> {
    let serialized = serde_json::to_string(&item).expect("context item is serializable");
    if serialized.len() <= CHECKPOINT_SUMMARY_INPUT_BYTES {
        return vec![item];
    }
    let segments = split_utf8_by_bytes(&serialized, CHECKPOINT_SUMMARY_INPUT_BYTES);
    let count = segments.len();
    segments
        .into_iter()
        .enumerate()
        .map(|(index, segment)| {
            json!({
                "role":"developer",
                "content":format!(
                    "[Cybion durable context segment {}/{}; preserve it as evidence and combine every segment before summarizing.]\n{}",
                    index + 1,
                    count,
                    segment,
                ),
            })
        })
        .collect()
}

fn split_utf8_by_bytes(value: &str, limit: usize) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, character) in value.char_indices() {
        let width = character.len_utf8();
        if bytes + width > limit && start < index {
            segments.push(&value[start..index]);
            start = index;
            bytes = 0;
        }
        bytes += width;
    }
    if start < value.len() {
        segments.push(&value[start..]);
    }
    segments
}

fn context_summary_bytes(batches: &[Vec<Value>]) -> usize {
    batches
        .iter()
        .flatten()
        .map(|item| {
            serde_json::to_vec(item)
                .expect("context summary item is serializable")
                .len()
        })
        .sum()
}

async fn responses_request(
    state: &AppState,
    integrations: &IntegrationSettings,
    model: &str,
    input: Value,
    include_tools: bool,
    max_output_tokens: Option<usize>,
) -> Result<ResponsesResult, ApiError> {
    let payload = responses_payload(model, input, include_tools, max_output_tokens);
    let response = state
        .client
        .post(format!(
            "{}/responses",
            integrations.openai_base_url.trim_end_matches('/')
        ))
        .bearer_auth(&integrations.openai_consumer_secret)
        .header("Accept", "text/event-stream")
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let response_id = response
        .headers()
        .get("x-openai-lb-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.text().await?;
    if !status.is_success() {
        let message = format!(
            "upstream Responses request failed with HTTP {status}: {}",
            upstream_error_detail(&body)
        );
        if context_overflow_response(&body) {
            return Err(ApiError::context_overflow(message));
        }
        return Err(ApiError::unavailable(message));
    }
    if body.trim_start().starts_with('{') {
        return serde_json::from_str(&body)
            .map(|value| ResponsesResult {
                value,
                request_id: response_id,
            })
            .map_err(ApiError::internal);
    }
    completed_response_from_sse(&body)
        .map(|value| ResponsesResult {
            value,
            request_id: response_id,
        })
        .map_err(|cause| {
            if context_overflow_response(&body) {
                return ApiError::context_overflow(format!(
                    "upstream Responses stream exceeded the context window: {cause}"
                ));
            }
            ApiError::unavailable(format!(
                "upstream Responses stream could not be read: {cause}"
            ))
        })
}

fn response_usage(response: &Value) -> (Option<i64>, Option<i64>, Option<i64>) {
    (
        response
            .pointer("/usage/input_tokens")
            .and_then(Value::as_i64),
        response
            .pointer("/usage/output_tokens")
            .and_then(Value::as_i64),
        response
            .pointer("/usage/input_tokens_details/cached_tokens")
            .and_then(Value::as_i64),
    )
}

async fn update_reasoning_audit_usage(
    state: &AppState,
    tenant: &Tenant,
    run_id: &str,
    response: &Value,
    request_id: Option<String>,
) {
    let (input_tokens, output_tokens, cached_tokens) = response_usage(response);
    let run_id = run_id.to_owned();
    let result = tenant_db(state, tenant, false, move |connection| {
        connection.execute(
            "UPDATE reasoning_audits SET input_tokens=?,output_tokens=?,cached_tokens=?,openai_lb_request_id=? WHERE run_id=?",
            params![input_tokens, output_tokens, cached_tokens, request_id, run_id],
        )?;
        Ok(())
    })
    .await;
    if let Err(error) = result {
        tracing::warn!(error = %error.message, "could not update reasoning audit usage");
    }
}

fn responses_payload(
    model: &str,
    input: Value,
    include_tools: bool,
    max_output_tokens: Option<usize>,
) -> Value {
    let mut payload = json!({"model":model,"input":input,"store":false,"stream":true});
    if include_tools {
        payload["tools"] = worker_tools();
    }
    if let Some(max_output_tokens) = max_output_tokens {
        payload["max_output_tokens"] = json!(max_output_tokens);
    }
    payload
}

fn upstream_error_detail(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.pointer("/detail"))
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|detail| !detail.trim().is_empty())
        .unwrap_or_else(|| body.trim().to_owned())
}

fn context_overflow_response(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .is_some_and(|value| context_overflow_value(&value))
        || body
            .replace("\r\n", "\n")
            .split("\n\n")
            .filter_map(sse_event_data)
            .filter_map(|(_, data)| serde_json::from_str::<Value>(&data).ok())
            .any(|value| context_overflow_value(&value))
}

fn context_overflow_value(value: &Value) -> bool {
    matches!(
        value
            .pointer("/error/code")
            .or_else(|| value.pointer("/response/error/code"))
            .or_else(|| value.pointer("/response/incomplete_details/reason"))
            .or_else(|| value.get("code"))
            .and_then(Value::as_str),
        Some("context_length_exceeded" | "context_window_exceeded")
    )
}

fn completed_response_from_sse(body: &str) -> Result<Value> {
    let mut output = Vec::new();
    let mut saw_done = false;
    let normalized = body.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        let Some((event_name, data)) = sse_event_data(block) else {
            continue;
        };
        if data.trim() == "[DONE]" {
            saw_done = true;
            continue;
        }
        let event: Value = serde_json::from_str(&data)
            .with_context(|| format!("invalid Responses SSE payload: {data}"))?;
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .or(event_name)
            .unwrap_or_default();
        match event_type {
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    output.push(item.clone());
                }
            }
            "response.completed" => {
                let mut response = event
                    .get("response")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Responses completion has no response"))?;
                if output.is_empty()
                    && let Some(existing) = response.get("output").and_then(Value::as_array)
                {
                    output = existing.clone();
                }
                response["output"] = Value::Array(output);
                return Ok(response);
            }
            "error" | "response.failed" | "response.incomplete" => {
                return Err(anyhow::anyhow!(
                    "upstream {event_type}: {}",
                    upstream_error_detail(&event.to_string())
                ));
            }
            _ => {}
        }
    }
    if saw_done {
        Err(anyhow::anyhow!(
            "upstream stream sent [DONE] without a Responses completion event"
        ))
    } else {
        Err(anyhow::anyhow!(
            "upstream stream ended without a completed response"
        ))
    }
}

fn sse_event_data(block: &str) -> Option<(Option<&str>, String)> {
    let mut event_name = None;
    let mut data = Vec::new();
    for line in block.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event_name = Some(value),
            "data" => data.push(value),
            _ => {}
        }
    }
    (!data.is_empty()).then(|| (event_name, data.join("\n")))
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
            let text = output_text(response.get("output")?.as_array()?);
            (!text.is_empty()).then_some(text)
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
                thread_locks: Arc::new(Mutex::new(HashMap::new())),
            },
        )
    }

    async fn read_json_request(stream: &mut tokio::net::TcpStream) -> Value {
        use tokio::io::AsyncReadExt;

        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0, "upstream client closed before sending a request");
            bytes.extend_from_slice(&buffer[..read]);
            let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = std::str::from_utf8(&bytes[..headers_end]).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            let body_start = headers_end + 4;
            if bytes.len() >= body_start + content_length {
                return serde_json::from_slice(&bytes[body_start..body_start + content_length])
                    .unwrap();
            }
        }
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
            turn_index: 1,
            status: "queued".to_owned(),
            error: None,
            started_at: now(),
            finished_at: None,
        };
        tenant_db(&state, &tenant, true, {
            let run = run.clone();
            move |connection| {
                connection.execute(
                    "INSERT INTO thread_runs(id,thread_id,turn_index,status,started_at) VALUES(?,?,?,?,?)",
                    params![run.id, run.thread_id, run.turn_index, run.status, run.started_at],
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
    async fn later_turns_wait_for_an_active_predecessor() {
        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "ordered-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Ordered turns".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                connection.execute(
                    "INSERT INTO thread_runs(id,thread_id,turn_index,status,started_at)
                     VALUES('first',?,1,'running',?),('second',?,2,'queued',?)",
                    params![&thread_id, now(), &thread_id, now()],
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        let second = RunView {
            id: "second".to_owned(),
            thread_id: thread.id.clone(),
            turn_index: 2,
            status: "queued".to_owned(),
            error: None,
            started_at: now(),
            finished_at: None,
        };
        assert!(
            prior_turn_is_active(&state, &tenant, &second)
                .await
                .unwrap()
        );
        tenant_db(&state, &tenant, false, |connection| {
            connection.execute(
                "UPDATE thread_runs SET status='completed' WHERE id='first'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(
            !prior_turn_is_active(&state, &tenant, &second)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn startup_recovery_terminalizes_interrupted_turns() {
        let (root, state) = test_state();
        let tenant = tenant_for_subject(&state, "restart-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Restart recovery".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                connection.execute(
                    "INSERT INTO thread_runs(id,thread_id,turn_index,status,started_at)
                     VALUES('interrupted',?,1,'running',?)",
                    params![thread_id, now()],
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        recover_interrupted_turns(root.path()).unwrap();
        let recovered = tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                let run_status: String = connection.query_row(
                    "SELECT status FROM thread_runs WHERE id='interrupted'",
                    [],
                    |row| row.get(0),
                )?;
                let thread_status: String = connection.query_row(
                    "SELECT status FROM threads WHERE id=?",
                    [thread_id],
                    |row| row.get(0),
                )?;
                let activity: String = connection.query_row(
                    "SELECT content FROM history_records WHERE run_id='interrupted' AND kind='activity'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((run_status, thread_status, activity))
            }
        })
        .await
        .unwrap();
        assert_eq!(recovered.0, "failed");
        assert_eq!(recovered.1, "failed");
        assert_eq!(recovered.2, "Run interrupted by a Cybion restart");
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

    #[test]
    fn responses_payload_always_requests_streaming() {
        let payload = responses_payload("test-model", json!([]), false, None);
        assert_eq!(payload.get("stream").and_then(Value::as_bool), Some(true));
        assert_eq!(payload.get("store").and_then(Value::as_bool), Some(false));
        assert!(payload.get("previous_response_id").is_none());
    }

    #[tokio::test]
    async fn thread_context_starts_at_its_checkpoint_and_excludes_future_turns() {
        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "context-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Context test".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        let sibling = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Sibling".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        let compiled = tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            let sibling_id = sibling.id.clone();
            move |connection| {
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-1"),
                        turn_index: 1,
                        role: "user",
                        content: "first request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"first request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-1"),
                        turn_index: 1,
                        role: "assistant",
                        content: "first answer",
                        kind: "response_output",
                        payload: &json!({
                            "type":"message",
                            "role":"assistant",
                            "content":[{"type":"output_text","text":"first answer"}],
                        }),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-2"),
                        turn_index: 2,
                        role: "user",
                        content: "second request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"second request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-1"),
                        turn_index: 1,
                        role: "system",
                        content: "Context checkpoint",
                        kind: "checkpoint",
                        payload: &json!({"role":"developer","content":"# Current state\nFirst turn is complete."}),
                        visible: false,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-2"),
                        turn_index: 2,
                        role: "tool",
                        content: "",
                        kind: "response_output",
                        payload: &json!({"type":"function_call","call_id":"call-2","name":"bash","arguments":"{}"}),
                        visible: false,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-3"),
                        turn_index: 3,
                        role: "user",
                        content: "future request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"future request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                let tool_id = persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-2"),
                        turn_index: 2,
                        role: "tool",
                        content: "done",
                        kind: "tool_output",
                        payload: &json!({"type":"function_call_output","call_id":"call-2","output":"done"}),
                        visible: false,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &sibling_id,
                        run_id: Some("sibling-run"),
                        turn_index: 1,
                        role: "user",
                        content: "private sibling request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"private sibling request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                let context = compile_thread_context(connection, &thread_id, 2)?;
                Ok((context, tool_id))
            }
        })
        .await
        .unwrap();
        assert_eq!(compiled.0.current_turn_tail_id, compiled.1);
        assert_eq!(
            compiled.0.items,
            vec![
                json!({"role":"developer","content":"# Current state\nFirst turn is complete."}),
                json!({"role":"user","content":"second request"}),
                json!({"type":"function_call","call_id":"call-2","name":"bash","arguments":"{}"}),
                json!({"type":"function_call_output","call_id":"call-2","output":"done"}),
            ]
        );
    }

    #[tokio::test]
    async fn live_responses_request_replays_durable_checkpoint_context() {
        use tokio::io::AsyncWriteExt;

        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "request-replay-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Replay request".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        let run = RunView {
            id: "run-2".to_owned(),
            thread_id: thread.id.clone(),
            turn_index: 2,
            status: "running".to_owned(),
            error: None,
            started_at: now(),
            finished_at: None,
        };
        tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-1"),
                        turn_index: 1,
                        role: "user",
                        content: "old request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"old request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-1"),
                        turn_index: 1,
                        role: "system",
                        content: "Context checkpoint",
                        kind: "checkpoint",
                        payload: &json!({"role":"developer","content":"# Current state\nOld work is done."}),
                        visible: false,
                        created_at: now(),
                    },
                )?;
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("run-2"),
                        turn_index: 2,
                        role: "user",
                        content: "new request",
                        kind: "input",
                        payload: &json!({"role":"user","content":"new request"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_json_request(&mut socket).await;
            sent.send(request).unwrap();
            let body = json!({
                "id":"resp_1",
                "output":[{
                    "type":"message",
                    "role":"assistant",
                    "content":[{"type":"output_text","text":"replayed"}],
                }],
            })
            .to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body,
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let integrations = IntegrationSettings {
            openai_consumer_id: "consumer".to_owned(),
            openai_consumer_secret: "secret".to_owned(),
            openai_base_url: format!("http://{address}"),
            linkit_bot_id: String::new(),
            linkit_bot_token: String::new(),
            linkit_username: String::new(),
        };
        let result = run_agent(&state, &tenant, &thread, &integrations, None, &run)
            .await
            .unwrap();
        assert_eq!(result.2, "replayed");
        let request = received.await.unwrap();
        server.await.unwrap();
        assert_eq!(request["store"], false);
        assert!(request.get("previous_response_id").is_none());
        assert_eq!(
            request["input"],
            json!([
                {"role":"developer","content":"# Current state\nOld work is done."},
                {"role":"user","content":"new request"},
            ])
        );
        let stored = tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                connection
                    .query_row(
                        "SELECT payload FROM history_records
                     WHERE thread_id=? AND kind='response_output' ORDER BY id DESC LIMIT 1",
                        [thread_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(Into::into)
            }
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored).unwrap(),
            json!({
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"replayed"}],
            })
        );
    }

    #[tokio::test]
    async fn context_overflow_compacts_then_replays_the_persisted_checkpoint() {
        use tokio::io::AsyncWriteExt;

        let (_root, state) = test_state();
        let tenant = tenant_for_subject(&state, "checkpoint-user");
        let thread = create_thread_for(
            &state,
            &tenant,
            CreateThreadInput {
                title: Some("Checkpoint request".to_owned()),
                model: None,
            },
        )
        .await
        .unwrap();
        let run = RunView {
            id: "checkpoint-run".to_owned(),
            thread_id: thread.id.clone(),
            turn_index: 1,
            status: "running".to_owned(),
            error: None,
            started_at: now(),
            finished_at: None,
        };
        tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                persist_history_record(
                    connection,
                    HistoryRecordInsert {
                        thread_id: &thread_id,
                        run_id: Some("checkpoint-run"),
                        turn_index: 1,
                        role: "user",
                        content: "continue the work",
                        kind: "input",
                        payload: &json!({"role":"user","content":"continue the work"}),
                        visible: true,
                        created_at: now(),
                    },
                )?;
                Ok(())
            }
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (sent, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let responses = vec![
                (
                    "400 Bad Request",
                    json!({"error":{"code":"context_length_exceeded","message":"too long"}}),
                ),
                (
                    "200 OK",
                    json!({
                        "id":"checkpoint-response",
                        "output":[{
                            "type":"message",
                            "role":"assistant",
                            "content":[{"type":"output_text","text":"# Current state\nContinue safely."}],
                        }],
                    }),
                ),
                (
                    "200 OK",
                    json!({
                        "id":"final-response",
                        "output":[{
                            "type":"message",
                            "role":"assistant",
                            "content":[{"type":"output_text","text":"finished"}],
                        }],
                    }),
                ),
            ];
            let mut requests = Vec::new();
            for (status, response) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                requests.push(read_json_request(&mut socket).await);
                let body = response.to_string();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body,
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            sent.send(requests).unwrap();
        });
        let integrations = IntegrationSettings {
            openai_consumer_id: "consumer".to_owned(),
            openai_consumer_secret: "secret".to_owned(),
            openai_base_url: format!("http://{address}"),
            linkit_bot_id: String::new(),
            linkit_bot_token: String::new(),
            linkit_username: String::new(),
        };
        let result = run_agent(&state, &tenant, &thread, &integrations, None, &run)
            .await
            .unwrap();
        assert_eq!(result.2, "finished");
        let requests = received.await.unwrap();
        server.await.unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0]["input"],
            json!([{"role":"user","content":"continue the work"}])
        );
        assert!(
            requests[1]["input"][0]["content"]
                .as_str()
                .unwrap()
                .contains("# Thread context checkpoint")
        );
        assert_eq!(
            requests[1]["input"][1],
            json!({"role":"user","content":"continue the work"})
        );
        assert_eq!(
            requests[2]["input"],
            json!([{"role":"developer","content":"# Current state\nContinue safely."}])
        );
        assert!(
            requests
                .iter()
                .all(|request| request["store"] == Value::Bool(false))
        );
        let kinds = tenant_db(&state, &tenant, false, {
            let thread_id = thread.id.clone();
            move |connection| {
                let mut statement = connection
                    .prepare("SELECT kind FROM history_records WHERE thread_id=? ORDER BY id")?;
                let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(Into::into)
            }
        })
        .await
        .unwrap();
        assert_eq!(kinds, vec!["input", "checkpoint", "response_output"]);
    }

    #[test]
    fn legacy_history_rows_are_upgraded_to_replayable_protocol_items() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("legacy.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    model TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                 );
                 INSERT INTO threads VALUES ('thread-1','Legacy','test','idle',1,1);
                 CREATE TABLE history_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    thread_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                 );
                 INSERT INTO history_records(thread_id,role,content,created_at)
                    VALUES ('thread-1','user','remember this',1),
                           ('thread-1','assistant','remembered',2);
                 CREATE TABLE thread_runs (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    error TEXT,
                    started_at INTEGER NOT NULL,
                    finished_at INTEGER
                 );
                 INSERT INTO thread_runs VALUES ('run-1','thread-1','completed',NULL,1,2);",
            )
            .unwrap();
        drop(connection);
        let upgraded = open_tenant(&path, true).unwrap();
        let records = upgraded
            .prepare("SELECT kind,payload,turn_index FROM history_records ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(records[0].0, "input");
        assert_eq!(
            serde_json::from_str::<Value>(&records[0].1).unwrap(),
            json!({"role":"user","content":"remember this"})
        );
        assert_eq!(records[1].0, "response_output");
        assert_eq!(
            serde_json::from_str::<Value>(&records[1].1).unwrap(),
            json!({
                "type":"message",
                "role":"assistant",
                "content":[{"type":"output_text","text":"remembered"}],
            })
        );
        assert_eq!(records[0].2, 0);
        assert_eq!(records[1].2, 0);
        let turn_index: i64 = upgraded
            .query_row(
                "SELECT turn_index FROM thread_runs WHERE id='run-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(turn_index, 1);
    }

    #[test]
    fn raw_tool_output_is_retained_while_replay_is_bounded() {
        let output = format!("{}终", "文".repeat(MAX_CONTEXT_TOOL_OUTPUT_CHARS));
        let item = json!({"type":"function_call_output","call_id":"call-1","output":output});
        let replayed = context_protocol_item(&item);
        assert_eq!(
            item["output"].as_str().unwrap().chars().count(),
            MAX_CONTEXT_TOOL_OUTPUT_CHARS + 1
        );
        assert_eq!(
            replayed["output"].as_str().unwrap(),
            format!(
                "{}{}",
                "文".repeat(MAX_CONTEXT_TOOL_OUTPUT_CHARS),
                TOOL_OUTPUT_TRUNCATED_NOTICE
            )
        );
    }

    #[test]
    fn context_overflow_detection_requires_an_upstream_error_code() {
        assert!(context_overflow_response(
            r#"{"error":{"code":"context_length_exceeded","message":"too long"}}"#
        ));
        assert!(context_overflow_response(
            "event: response.failed\ndata: {\"error\":{\"code\":\"context_window_exceeded\"}}\n\n"
        ));
        assert!(!context_overflow_response(
            r#"{"error":{"code":"invalid_request_error","message":"too long"}}"#
        ));
    }

    #[test]
    fn responses_sse_is_reassembled_into_a_completed_response() {
        let body = concat!(
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\"}]}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n",
            "data: [DONE]\n\n",
        );
        let response = completed_response_from_sse(body).unwrap();
        assert_eq!(response["id"], "resp_1");
        assert_eq!(response["output"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn upstream_error_detail_prefers_structured_detail() {
        assert_eq!(
            upstream_error_detail(r#"{"detail":"Stream must be set to true"}"#),
            "Stream must be set to true"
        );
    }
}
