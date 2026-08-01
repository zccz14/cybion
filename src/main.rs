mod resources;
mod update;

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;
use url::Url;
use uuid::Uuid;

const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL_ID: &str = "gpt-5.6-terra";
const JWKS_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    client: reqwest::Client,
    jwks: Arc<RwLock<Option<CachedJwks>>>,
    resources: Arc<Mutex<resources::ResourceMonitor>>,
}

struct CachedJwks {
    fetched_at: Instant,
    keys: Vec<Jwk>,
}

#[derive(Clone, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Clone, Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    crv: String,
    x: String,
    alg: String,
}

#[derive(Clone)]
struct Identity {
    token: String,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

type ApiResult<T> = std::result::Result<Json<T>, (StatusCode, Json<ApiError>)>;

#[derive(Serialize)]
struct StatusResponse {
    machine_id: String,
    hostname: String,
    root_user_id: String,
    auth_url: String,
    openai_base_url: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Serialize)]
struct FileContent {
    path: String,
    content: String,
    encoding: String,
}

#[derive(Deserialize)]
struct WriteFile {
    path: String,
    content: String,
    encoding: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Peer {
    id: String,
    name: String,
    base_url: String,
    created_at: String,
}

#[derive(Deserialize)]
struct CreatePeer {
    name: String,
    base_url: String,
}

#[derive(Deserialize, Serialize, Clone)]
struct ChatMessage {
    role: String,
    content: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Value>,
}

#[derive(Deserialize)]
struct AgentTurn {
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
struct SettingsResponse {
    default_model: String,
}

#[derive(Deserialize)]
struct UpdateSettings {
    default_model: String,
}

#[derive(Deserialize)]
struct SetupInput {
    auth_url: String,
    openai_api_key: String,
    #[serde(default = "default_openai_url")]
    openai_base_url: String,
}

#[derive(Serialize)]
struct AgentReply {
    message: ChatMessage,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("mobius=info,tower_http=info")
        .compact()
        .init();
    let db_path = default_db_path();
    bootstrap_database(&db_path)?;
    let state = AppState {
        db_path,
        client: reqwest::Client::builder()
            .user_agent(format!("mobius/{}", env!("CARGO_PKG_VERSION")))
            .build()?,
        jwks: Arc::new(RwLock::new(None)),
        resources: Arc::new(Mutex::new(resources::ResourceMonitor::new(
            default_db_path(),
        ))),
    };
    schedule_auto_update(state.clone());
    let addr: SocketAddr = "0.0.0.0:1858".parse().expect("constant address is valid");
    info!(%addr, "mobius server listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app(state)).await?;
    Ok(())
}

fn schedule_auto_update(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(cause) = update::download_latest(&state.client, &state.db_path).await {
                tracing::warn!(%cause, "Mobius automatic update check failed");
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth-config.js", get(auth_config_script))
        .route("/", get(index))
        .route("/assets/app.js", get(app_js))
        .route("/assets/app.css", get(app_css))
        .route("/api/setup", post(setup))
        .route("/api/status", get(status))
        .route("/api/settings", get(settings).put(update_settings))
        .route("/api/system/resources", get(system_resources))
        .route("/api/update", get(download_update))
        .route("/api/update/restart", post(restart_update))
        .route("/api/files", get(list_files))
        .route("/api/files/read", get(read_file))
        .route("/api/files/write", put(write_file))
        .route("/api/peers", get(list_peers).post(create_peer))
        .route("/api/peers/{id}", delete(delete_peer))
        .route("/api/peers/{id}/status", get(peer_status))
        .route("/api/agent/turn", post(agent_turn))
        .with_state(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
}

fn default_db_path() -> PathBuf {
    directories::BaseDirs::new()
        .expect("home directory is required")
        .home_dir()
        .join(".mobius/default.sqlite3")
}

fn open_db(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    Ok(connection)
}

fn bootstrap_database(db: &Path) -> Result<()> {
    let parent = db.parent().context("database path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let connection = open_db(db)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS peers (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           base_url TEXT NOT NULL UNIQUE,
           created_at TEXT NOT NULL
         );",
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('machine_id', ?1)
         ON CONFLICT(key) DO NOTHING",
        [Uuid::new_v4().to_string()],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('default_model', ?1)
         ON CONFLICT(key) DO NOTHING",
        [DEFAULT_MODEL_ID],
    )?;
    Ok(())
}

fn default_openai_url() -> String {
    DEFAULT_OPENAI_URL.to_owned()
}

#[derive(Clone)]
struct Config {
    root_user_id: String,
    auth_url: String,
    openai_base_url: String,
    openai_api_key: String,
    default_model: String,
    machine_id: String,
}

fn load_config(path: &Path) -> Result<Config> {
    let connection = open_db(path)?;
    let values: HashMap<String, String> = connection
        .prepare("SELECT key, value FROM app_meta")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let required = |key: &str| {
        values
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow!("missing {key} in app_meta"))
    };
    Ok(Config {
        root_user_id: required("root_user_id")?,
        auth_url: required("auth_url")?,
        openai_base_url: required("openai_base_url")?,
        openai_api_key: required("openai_api_key")?,
        default_model: required("default_model")?,
        machine_id: required("machine_id")?,
    })
}

fn error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

async fn identity(
    state: &AppState,
    headers: &HeaderMap,
) -> std::result::Result<Identity, (StatusCode, Json<ApiError>)> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "missing bearer token"))?
        .to_owned();
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid server configuration",
        )
    })?;
    let header =
        decode_header(&token).map_err(|_| error(StatusCode::UNAUTHORIZED, "invalid JWT header"))?;
    let kid = header
        .kid
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT has no key id"))?;
    let keys = cached_keys(state, &config.auth_url)
        .await
        .map_err(|_| error(StatusCode::UNAUTHORIZED, "cannot load Auth Mini JWKS"))?;
    let jwk = keys
        .iter()
        .find(|key| {
            key.kid == kid && key.kty == "OKP" && key.crv == "Ed25519" && key.alg == "EdDSA"
        })
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT signing key is not trusted"))?;
    let audience = request_audience(headers)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "request has no host audience"))?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[&config.auth_url]);
    validation.set_audience(&[audience]);
    let claims = decode::<Value>(
        &token,
        &DecodingKey::from_ed_components(&jwk.x)
            .map_err(|_| error(StatusCode::UNAUTHORIZED, "invalid JWKS key"))?,
        &validation,
    )
    .map_err(|_| error(StatusCode::UNAUTHORIZED, "JWT verification failed"))?
    .claims;
    let user_id = claims
        .get("sub")
        .and_then(Value::as_str)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT has no subject"))?;
    if user_id != config.root_user_id {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Mobius is restricted to its configured root user",
        ));
    }
    Ok(Identity { token })
}

async fn cached_keys(state: &AppState, auth_url: &str) -> Result<Vec<Jwk>> {
    if let Some(cached) = state.jwks.read().await.as_ref()
        && cached.fetched_at.elapsed() < JWKS_TTL
    {
        return Ok(cached.keys.clone());
    }
    let jwks = state
        .client
        .get(format!("{auth_url}/jwks"))
        .send()
        .await?
        .error_for_status()?
        .json::<Jwks>()
        .await?;
    *state.jwks.write().await = Some(CachedJwks {
        fetched_at: Instant::now(),
        keys: jwks.keys.clone(),
    });
    Ok(jwks.keys)
}

fn request_audience(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    Url::parse(&format!("http://{host}"))
        .ok()?
        .host_str()
        .map(str::to_owned)
}

async fn health() -> &'static str {
    "ok"
}

async fn auth_config_script(State(state): State<AppState>) -> Response {
    match load_config(&state.db_path) {
        Ok(config) => javascript_response(format!(
            "window.__MOBIUS_AUTH_URL = {};",
            serde_json::to_string(&config.auth_url).unwrap()
        )),
        Err(_) => javascript_response("window.__MOBIUS_AUTH_URL = null;".to_owned()),
    }
}

async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SetupInput>,
) -> ApiResult<StatusResponse> {
    if load_config(&state.db_path).is_ok() {
        return Err(error(StatusCode::CONFLICT, "Mobius is already initialized"));
    }
    let auth_url = input.auth_url.trim_end_matches('/').to_owned();
    Url::parse(&auth_url)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "auth_url must be an absolute URL"))?;
    Url::parse(&input.openai_base_url).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "openai_base_url must be an absolute URL",
        )
    })?;
    if input.openai_api_key.trim().is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "openai_api_key cannot be empty",
        ));
    }
    let root_user_id = bootstrap_subject(&state, &headers, &auth_url).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    for (key, value) in [
        ("root_user_id", root_user_id.as_str()),
        ("auth_url", auth_url.as_str()),
        (
            "openai_base_url",
            input.openai_base_url.trim_end_matches('/'),
        ),
        ("openai_api_key", input.openai_api_key.as_str()),
    ] {
        connection.execute("INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])
            .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot persist initial configuration"))?;
    }
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read initial configuration",
        )
    })?;
    Ok(Json(StatusResponse {
        machine_id: config.machine_id,
        hostname: hostname(),
        root_user_id: config.root_user_id,
        auth_url: config.auth_url,
        openai_base_url: config.openai_base_url,
    }))
}

async fn bootstrap_subject(
    state: &AppState,
    headers: &HeaderMap,
    auth_url: &str,
) -> std::result::Result<String, (StatusCode, Json<ApiError>)> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "sign in with Auth Mini before initializing Mobius",
            )
        })?;
    let header =
        decode_header(token).map_err(|_| error(StatusCode::UNAUTHORIZED, "invalid JWT header"))?;
    let kid = header
        .kid
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT has no key id"))?;
    let keys = cached_keys(state, auth_url)
        .await
        .map_err(|_| error(StatusCode::UNAUTHORIZED, "cannot load Auth Mini JWKS"))?;
    let key = keys
        .iter()
        .find(|key| {
            key.kid == kid && key.kty == "OKP" && key.crv == "Ed25519" && key.alg == "EdDSA"
        })
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT signing key is not trusted"))?;
    let audience = request_audience(headers)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "request has no host audience"))?;
    let mut validation = Validation::new(Algorithm::EdDSA);
    validation.set_issuer(&[auth_url]);
    validation.set_audience(&[audience]);
    let claims = decode::<Value>(
        token,
        &DecodingKey::from_ed_components(&key.x)
            .map_err(|_| error(StatusCode::UNAUTHORIZED, "invalid JWKS key"))?,
        &validation,
    )
    .map_err(|_| error(StatusCode::UNAUTHORIZED, "JWT verification failed"))?
    .claims;
    claims
        .get("sub")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "JWT has no subject"))
}

async fn index() -> Response {
    asset(
        include_bytes!("../web/dist/index.html"),
        "text/html; charset=utf-8",
    )
}
async fn app_js() -> Response {
    asset(
        include_bytes!("../web/dist/assets/app.js"),
        "text/javascript; charset=utf-8",
    )
}
async fn app_css() -> Response {
    asset(
        include_bytes!("../web/dist/assets/app.css"),
        "text/css; charset=utf-8",
    )
}

fn asset(bytes: &'static [u8], content_type: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        Body::from(bytes),
    )
        .into_response()
}

fn javascript_response(source: String) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/javascript; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        source,
    )
        .into_response()
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<StatusResponse> {
    identity(&state, &headers).await?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    Ok(Json(StatusResponse {
        machine_id: config.machine_id,
        hostname: hostname(),
        root_user_id: config.root_user_id,
        auth_url: config.auth_url,
        openai_base_url: config.openai_base_url,
    }))
}

async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<SettingsResponse> {
    identity(&state, &headers).await?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    Ok(Json(SettingsResponse {
        default_model: config.default_model,
    }))
}

async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateSettings>,
) -> ApiResult<SettingsResponse> {
    identity(&state, &headers).await?;
    let default_model = input.default_model.trim();
    if default_model.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "default_model cannot be empty",
        ));
    }
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('default_model', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [default_model],
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot save default model",
            )
        })?;
    Ok(Json(SettingsResponse {
        default_model: default_model.to_owned(),
    }))
}

async fn system_resources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<resources::SystemResourcesSnapshot> {
    identity(&state, &headers).await?;
    let snapshot = state
        .resources
        .lock()
        .await
        .sample()
        .map_err(|cause| error(StatusCode::INTERNAL_SERVER_ERROR, cause.to_string()))?;
    Ok(Json(snapshot))
}

async fn download_update(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<update::UpdateStatus> {
    identity(&state, &headers).await?;
    let status = update::download_latest(&state.client, &state.db_path)
        .await
        .map_err(|cause| error(StatusCode::BAD_GATEWAY, cause.to_string()))?;
    Ok(Json(status))
}

async fn restart_update(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Value> {
    identity(&state, &headers).await?;
    update::restart(&state.db_path)
        .map_err(|cause| error(StatusCode::BAD_REQUEST, cause.to_string()))?;
    Ok(Json(json!({ "restarting": true })))
}

async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> ApiResult<Vec<FileEntry>> {
    identity(&state, &headers).await?;
    let mut entries = std::fs::read_dir(&query.path)
        .map_err(|cause| {
            error(
                StatusCode::BAD_REQUEST,
                format!("cannot read {}: {cause}", query.path),
            )
        })?
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let path = entry.path();
            Some(FileEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.display().to_string(),
                kind: if metadata.is_dir() {
                    "directory".to_owned()
                } else {
                    "file".to_owned()
                },
                size: metadata.len(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Json(entries))
}

async fn read_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> ApiResult<FileContent> {
    identity(&state, &headers).await?;
    let bytes = std::fs::read(&query.path).map_err(|cause| {
        error(
            StatusCode::BAD_REQUEST,
            format!("cannot read {}: {cause}", query.path),
        )
    })?;
    let (content, encoding) = match String::from_utf8(bytes) {
        Ok(content) => (content, "utf8".to_owned()),
        Err(error) => (BASE64.encode(error.into_bytes()), "base64".to_owned()),
    };
    Ok(Json(FileContent {
        path: query.path,
        content,
        encoding,
    }))
}

async fn write_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(file): Json<WriteFile>,
) -> ApiResult<FileContent> {
    identity(&state, &headers).await?;
    let bytes = match file.encoding.as_deref() {
        Some("base64") => BASE64
            .decode(&file.content)
            .map_err(|_| error(StatusCode::BAD_REQUEST, "content is not valid base64"))?,
        _ => file.content.as_bytes().to_vec(),
    };
    std::fs::write(&file.path, bytes).map_err(|cause| {
        error(
            StatusCode::BAD_REQUEST,
            format!("cannot write {}: {cause}", file.path),
        )
    })?;
    Ok(Json(FileContent {
        path: file.path,
        content: file.content,
        encoding: file.encoding.unwrap_or_else(|| "utf8".to_owned()),
    }))
}

async fn list_peers(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Vec<Peer>> {
    identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let peers = connection
        .prepare("SELECT id, name, base_url, created_at FROM peers ORDER BY name")
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot prepare peer query",
            )
        })?
        .query_map([], |row| {
            Ok(Peer {
                id: row.get(0)?,
                name: row.get(1)?,
                base_url: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read peers"))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot decode peers"))?;
    Ok(Json(peers))
}

async fn create_peer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreatePeer>,
) -> ApiResult<Peer> {
    identity(&state, &headers).await?;
    Url::parse(&input.base_url).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "peer base_url must be an absolute URL",
        )
    })?;
    let peer = Peer {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_owned(),
        base_url: input.base_url.trim_end_matches('/').to_owned(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    if peer.name.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "peer name cannot be empty"));
    }
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    connection
        .execute(
            "INSERT INTO peers (id, name, base_url, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![peer.id, peer.name, peer.base_url, peer.created_at],
        )
        .map_err(|cause| error(StatusCode::CONFLICT, format!("cannot add peer: {cause}")))?;
    Ok(Json(peer))
}

async fn delete_peer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let deleted = connection
        .execute("DELETE FROM peers WHERE id = ?1", [id])
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot delete peer"))?;
    if deleted == 0 {
        return Err(error(StatusCode::NOT_FOUND, "peer does not exist"));
    }
    Ok(Json(json!({"deleted": true})))
}

async fn peer_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    let actor = identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let base_url: String = connection
        .query_row("SELECT base_url FROM peers WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read peer"))?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "peer does not exist"))?;
    let response = state
        .client
        .get(format!("{base_url}/api/status"))
        .bearer_auth(actor.token)
        .send()
        .await
        .map_err(|cause| {
            error(
                StatusCode::BAD_GATEWAY,
                format!("peer request failed: {cause}"),
            )
        })?
        .error_for_status()
        .map_err(|cause| {
            error(
                StatusCode::BAD_GATEWAY,
                format!("peer rejected request: {cause}"),
            )
        })?
        .json::<Value>()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "peer returned invalid JSON"))?;
    Ok(Json(response))
}

async fn agent_turn(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AgentTurn>,
) -> ApiResult<AgentReply> {
    identity(&state, &headers).await?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    let message = run_agent(&state.client, &config, input)
        .await
        .map_err(|cause| error(StatusCode::BAD_GATEWAY, cause.to_string()))?;
    Ok(Json(AgentReply { message }))
}

async fn run_agent(
    client: &reqwest::Client,
    config: &Config,
    input: AgentTurn,
) -> Result<ChatMessage> {
    let mut items = input
        .messages
        .into_iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect::<Vec<_>>();
    for _ in 0..8 {
        let response = client
            .post(format!("{}/responses", config.openai_base_url))
            .bearer_auth(&config.openai_api_key)
            .json(&responses_request_body(&config.default_model, &items))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        let response = completed_response_from_sse(&response)?;
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("upstream returned no Responses output"))?;
        let calls = output
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .cloned()
            .collect::<Vec<_>>();
        if calls.is_empty() {
            return Ok(ChatMessage {
                role: "assistant".to_owned(),
                content: Value::String(output_text(&output)),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        items.extend(output);
        for call in calls {
            let call_id = call
                .get("call_id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("function call has no call_id"))?;
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("function call has no name"))?;
            let args: Value = serde_json::from_str(
                call.get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}"),
            )?;
            let result = execute_tool(name, args).await;
            items.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": result,
            }));
        }
    }
    Err(anyhow!("agent exceeded the eight tool-call rounds limit"))
}

fn responses_request_body(model: &str, input: &[Value]) -> Value {
    json!({
        "model": model,
        "input": input,
        "tools": tool_definitions(),
        "tool_choice": "auto",
        "store": false,
        "stream": true,
    })
}

fn completed_response_from_sse(body: &str) -> Result<Value> {
    let mut output = Vec::new();
    for data in body.lines().filter_map(|line| line.strip_prefix("data: ")) {
        let event: Value = serde_json::from_str(data)?;
        if event.get("type").and_then(Value::as_str) == Some("response.output_item.done") {
            output.push(
                event
                    .get("item")
                    .cloned()
                    .ok_or_else(|| anyhow!("completed output item event has no item"))?,
            );
        }
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            let mut response = event
                .get("response")
                .cloned()
                .ok_or_else(|| anyhow!("completed response event has no response"))?;
            response["output"] = Value::Array(output);
            return Ok(response);
        }
    }
    Err(anyhow!(
        "upstream stream ended without a completed response"
    ))
}

fn output_text(output: &[Value]) -> String {
    output
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
        .collect::<String>()
}

fn tool_definitions() -> Value {
    json!([
      {"type":"function","name":"list_files","description":"List files in any directory on this machine.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"}}}},
      {"type":"function","name":"read_file","description":"Read a file from any path on this machine. Binary files are returned as base64 JSON.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"}}}},
      {"type":"function","name":"write_file","description":"Write a UTF-8 text file to any existing path on this machine.","parameters":{"type":"object","additionalProperties":false,"required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"}}}}
    ])
}

async fn execute_tool(name: &str, args: Value) -> String {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    match name {
        "list_files" => match std::fs::read_dir(path) {
            Ok(entries) => serde_json::to_string(
                &entries
                    .filter_map(std::result::Result::ok)
                    .map(|entry| entry.path().display().to_string())
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
            Err(error) => format!("error: {error}"),
        },
        "read_file" => std::fs::read(path)
            .map(|bytes| match String::from_utf8(bytes) {
                Ok(content) => content,
                Err(error) => {
                    json!({"encoding":"base64","content":BASE64.encode(error.into_bytes())})
                        .to_string()
                }
            })
            .unwrap_or_else(|error| format!("error: {error}")),
        "write_file" => std::fs::write(
            path,
            args.get("content").and_then(Value::as_str).unwrap_or(""),
        )
        .map(|_| "written".to_owned())
        .unwrap_or_else(|error| format!("error: {error}")),
        _ => "error: unknown tool".to_owned(),
    }
}

fn hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_else(|| "this machine".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_creates_the_required_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        assert!(load_config(&db).is_err());
        let connection = open_db(&db).unwrap();
        let machine_id: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'machine_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!machine_id.is_empty());
        let default_model: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'default_model'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(default_model, DEFAULT_MODEL_ID);
    }

    #[test]
    fn responses_body_uses_input_and_responses_function_schema() {
        let body =
            responses_request_body("gpt-5", &[json!({"role":"user","content":"list files"})]);
        assert_eq!(
            body.get("input").and_then(Value::as_array).unwrap().len(),
            1
        );
        assert_eq!(
            body.pointer("/tools/0/type").and_then(Value::as_str),
            Some("function")
        );
        assert!(body.pointer("/tools/0/function").is_none());
        assert_eq!(body.get("store").and_then(Value::as_bool), Some(false));
        assert_eq!(body.get("stream").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn responses_text_uses_output_message_items() {
        let text = output_text(&[
            json!({"type":"reasoning","summary":[]}),
            json!({"type":"message","content":[{"type":"output_text","text":"done"}]}),
        ]);
        assert_eq!(text, "done");
    }

    #[tokio::test]
    async fn agent_uses_responses_endpoint_and_returns_function_outputs() {
        let requests = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        async fn responses(
            State(requests): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
            Json(request): Json<Value>,
        ) -> String {
            let mut requests = requests.lock().await;
            let response = if requests.is_empty() {
                json!({"output":[{"type":"function_call","call_id":"call_1","name":"list_files","arguments":"{\"path\":\"/\"}"}]})
            } else {
                json!({"output":[{"type":"message","content":[{"type":"output_text","text":"complete"}]}]})
            };
            let output = response.get("output").and_then(Value::as_array).unwrap();
            requests.push(request);
            format!(
                "event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
                json!({"type":"response.output_item.done","item":output[0]}),
                json!({"type":"response.completed","response":response})
            )
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_requests = requests.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/responses", post(responses))
                    .with_state(server_requests),
            )
            .await
            .unwrap();
        });
        let config = Config {
            root_user_id: "root".to_owned(),
            auth_url: "https://auth.example.com".to_owned(),
            openai_base_url: format!("http://{address}"),
            openai_api_key: "test".to_owned(),
            default_model: DEFAULT_MODEL_ID.to_owned(),
            machine_id: "machine".to_owned(),
        };
        let reply = run_agent(
            &reqwest::Client::new(),
            &config,
            AgentTurn {
                messages: vec![ChatMessage {
                    role: "user".to_owned(),
                    content: Value::String("list root".to_owned()),
                    tool_call_id: None,
                    tool_calls: None,
                }],
            },
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(reply.content, Value::String("complete".to_owned()));
        let requests = requests.lock().await;
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].get("model").and_then(Value::as_str),
            Some(DEFAULT_MODEL_ID)
        );
        assert_eq!(
            requests[0].pointer("/input/0/role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            requests[0].get("stream").and_then(Value::as_bool),
            Some(true)
        );
        assert!(
            requests[1]
                .get("input")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(
                    |item| item.get("type").and_then(Value::as_str) == Some("function_call_output")
                )
        );
    }
}
