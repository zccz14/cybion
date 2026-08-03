mod resources;
mod update;

use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, RwLock as StdRwLock, mpsc as std_mpsc},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{delete, get, post, put},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use notify::{RecursiveMode, Watcher};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use similar::{ChangeTag, TextDiff};
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock, mpsc, watch};
use tokio_stream::{StreamExt, wrappers::ReceiverStream};
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
    skills_directory: PathBuf,
    skills: Arc<StdRwLock<SkillCatalog>>,
    client: reqwest::Client,
    jwks: Arc<RwLock<Option<CachedJwks>>>,
    resources: Arc<Mutex<resources::ResourceMonitor>>,
    active_runs: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
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

#[derive(Serialize)]
struct TranscriptionResponse {
    text: String,
}

#[derive(Clone, Default)]
struct SkillCatalog {
    skills: Vec<SkillMetadata>,
}

#[derive(Clone, Serialize)]
struct SkillMetadata {
    name: String,
    description: String,
    directory: String,
}

#[derive(Serialize)]
struct SkillsResponse {
    directory: String,
    skills: Vec<SkillMetadata>,
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
    images: Option<Vec<GeneratedImage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
struct GeneratedImage {
    id: String,
    data: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct ConversationMessage {
    id: i64,
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<GeneratedImage>,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
}

#[derive(Serialize)]
struct ConversationState {
    messages: Vec<ConversationMessage>,
    runs: Vec<ConversationRun>,
}

#[derive(Serialize)]
struct ConversationRun {
    id: String,
    user_message_id: i64,
    status: String,
    events: Vec<AgentEvent>,
}

struct AgentEventSink<'a> {
    run_id: &'a str,
    sender: &'a mpsc::Sender<AgentEvent>,
}

#[derive(Clone, Copy)]
struct AgentUsage {
    duration_ms: u64,
    input_tokens: u64,
    output_tokens: u64,
}

struct AgentResult {
    message: ChatMessage,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Deserialize)]
struct AgentTurn {
    run_id: String,
    message: ChatMessage,
}

#[derive(Serialize)]
struct SettingsResponse {
    default_model: String,
    openai_base_url: String,
    openai_api_key: String,
}

#[derive(Deserialize)]
struct UpdateSettings {
    default_model: String,
    openai_base_url: String,
    openai_api_key: String,
}

#[derive(Serialize)]
struct ToolsetsResponse {
    filesystem_enabled: bool,
    bash_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
}

#[derive(Deserialize)]
struct UpdateToolsets {
    filesystem_enabled: bool,
    bash_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
}

#[derive(Serialize)]
struct WorkItem {
    id: i64,
    parent_id: Option<i64>,
    title: String,
    description: String,
    status: String,
    evidence_text: String,
    delivery_text: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct WorkGraph {
    items: Vec<WorkItem>,
    dependencies: Vec<WorkItemDependency>,
    ready_ids: Vec<i64>,
}

#[derive(Serialize)]
struct WorkItemDependency {
    work_item_id: i64,
    depends_on_id: i64,
}

#[derive(Deserialize)]
struct CreateWorkItem {
    parent_id: Option<i64>,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default = "default_work_item_status")]
    status: String,
    #[serde(default)]
    evidence_text: String,
    #[serde(default)]
    delivery_text: String,
    #[serde(default)]
    depends_on_ids: Vec<i64>,
}

fn default_work_item_status() -> String {
    "ready".to_owned()
}

#[derive(Deserialize)]
struct UpdateWorkItem {
    parent_id: Option<i64>,
    title: String,
    description: String,
    status: String,
    evidence_text: String,
    delivery_text: String,
    depends_on_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct SetupInput {
    auth_url: String,
    openai_api_key: String,
    #[serde(default = "default_openai_url")]
    openai_base_url: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentEvent {
    ToolCall {
        call_id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        call_id: String,
        name: String,
        added_lines: Option<usize>,
        deleted_lines: Option<usize>,
    },
    Context {
        input_tokens: u64,
    },
    Complete {
        message: ConversationMessage,
    },
    Error {
        error: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("mobius=info,tower_http=info")
        .compact()
        .init();
    if update::run_update_helper()? {
        return Ok(());
    }
    let db_path = default_db_path();
    if update::launch_installed_binary(&db_path)? {
        return Ok(());
    }
    bootstrap_database(&db_path)?;
    let skills_directory = default_skills_directory();
    let skills = Arc::new(StdRwLock::new(load_skills(&skills_directory)));
    watch_skills(skills_directory.clone(), skills.clone())?;
    let state = AppState {
        db_path: db_path.clone(),
        skills_directory,
        skills,
        client: reqwest::Client::builder()
            .user_agent(format!("mobius/{}", env!("CARGO_PKG_VERSION")))
            .build()?,
        jwks: Arc::new(RwLock::new(None)),
        resources: Arc::new(Mutex::new(resources::ResourceMonitor::new(
            default_db_path(),
        ))),
        active_runs: Arc::new(Mutex::new(HashMap::new())),
    };
    schedule_auto_update(state.clone());
    let addr: SocketAddr = "0.0.0.0:1858".parse().expect("constant address is valid");
    info!(%addr, "mobius server listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    update::record_startup(&db_path)?;
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
        .route("/api/toolsets", get(toolsets).put(update_toolsets))
        .route("/api/skills", get(skills))
        .route("/api/system/resources", get(system_resources))
        .route("/api/update", get(update_status))
        .route("/api/update/check", post(download_update))
        .route("/api/update/restart", post(restart_update))
        .route("/api/files", get(list_files))
        .route("/api/files/read", get(read_file))
        .route("/api/files/write", put(write_file))
        .route(
            "/api/audio/transcriptions",
            post(transcribe_audio).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route("/api/peers", get(list_peers).post(create_peer))
        .route("/api/peers/{id}", delete(delete_peer))
        .route("/api/peers/{id}/status", get(peer_status))
        .route("/api/conversation", get(conversation))
        .route("/api/work-items", get(work_graph).post(create_work_item))
        .route("/api/work-items/{id}", put(update_work_item))
        .route("/api/agent/turn", post(agent_turn))
        .route("/api/agent/turn/{id}", delete(cancel_agent_turn))
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

fn default_skills_directory() -> PathBuf {
    directories::BaseDirs::new()
        .expect("home directory is required")
        .home_dir()
        .join(".agents/skills")
}

fn skill_frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    (lines.next()? == "---").then_some(())?;
    lines.take_while(|line| *line != "---").find_map(|line| {
        let (field, value) = line.split_once(':')?;
        (field.trim() == key).then(|| value.trim().trim_matches(['\'', '"']).to_owned())
    })
}

fn load_skills(directory: &Path) -> SkillCatalog {
    let mut skills = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| entry.path())
        })
        .filter_map(|directory| {
            let skill_file = directory.join("SKILL.md");
            skill_file.is_file().then(|| {
                let content = std::fs::read_to_string(skill_file).unwrap_or_default();
                SkillMetadata {
                    name: skill_frontmatter_value(&content, "name").unwrap_or_else(|| {
                        directory
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    }),
                    description: skill_frontmatter_value(&content, "description")
                        .unwrap_or_default(),
                    directory: directory.to_string_lossy().into_owned(),
                }
            })
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    SkillCatalog { skills }
}

fn watch_skills(directory: PathBuf, skills: Arc<StdRwLock<SkillCatalog>>) -> Result<()> {
    std::fs::create_dir_all(&directory)?;
    std::thread::spawn(move || {
        let (sender, receiver) = std_mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |_| {
            let _ = sender.send(());
        }) {
            Ok(watcher) => watcher,
            Err(cause) => {
                tracing::warn!(%cause, "Mobius skill watcher could not start");
                return;
            }
        };
        if let Err(cause) = watcher.watch(&directory, RecursiveMode::Recursive) {
            tracing::warn!(%cause, "Mobius skill directory could not be watched");
            return;
        }
        while receiver.recv().is_ok() {
            while receiver.try_recv().is_ok() {}
            let catalog = load_skills(&directory);
            let count = catalog.skills.len();
            if let Ok(mut current) = skills.write() {
                *current = catalog;
                info!(%count, "Mobius skills reloaded");
            }
        }
    });
    Ok(())
}

fn open_db(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    Ok(connection)
}

fn load_conversation(path: &Path) -> Result<Vec<ConversationMessage>> {
    let connection = open_db(path)?;
    connection
        .prepare(
            "SELECT id, role, content, created_at, duration_ms, input_tokens, output_tokens, images
             FROM conversation_messages ORDER BY id",
        )?
        .query_map([], |row| {
            Ok(ConversationMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                duration_ms: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                images: serde_json::from_str(&row.get::<_, Option<String>>(7)?.unwrap_or_default())
                    .unwrap_or_default(),
            })
        })?
        .collect::<std::result::Result<_, _>>()
        .map_err(Into::into)
}

fn conversation_context(messages: Vec<ConversationMessage>) -> Vec<ChatMessage> {
    messages
        .into_iter()
        .map(|message| ChatMessage {
            role: message.role,
            content: Value::String(message.content),
            images: None,
            tool_call_id: None,
            tool_calls: None,
        })
        .collect()
}

fn append_conversation(
    path: &Path,
    message: &ChatMessage,
    usage: Option<AgentUsage>,
) -> Result<ConversationMessage> {
    let content = message
        .content
        .as_str()
        .ok_or_else(|| anyhow!("conversation content must be text"))?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let images = message.images.clone().unwrap_or_default();
    let images = serde_json::to_string(&images)?;
    let connection = open_db(path)?;
    connection.execute(
        "INSERT INTO conversation_messages (role, content, created_at, duration_ms, input_tokens, output_tokens, images)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.role,
            content,
            created_at,
            usage.map(|value| value.duration_ms),
            usage.map(|value| value.input_tokens),
            usage.map(|value| value.output_tokens),
            images,
        ],
    )?;
    Ok(ConversationMessage {
        id: connection.last_insert_rowid(),
        role: message.role.clone(),
        content: content.to_owned(),
        images: message.images.clone().unwrap_or_default(),
        created_at,
        duration_ms: usage.map(|value| value.duration_ms),
        input_tokens: usage.map(|value| value.input_tokens),
        output_tokens: usage.map(|value| value.output_tokens),
    })
}

fn create_agent_run(path: &Path, id: &str, user_message_id: i64) -> Result<()> {
    open_db(path)?.execute(
        "INSERT INTO agent_runs (id, user_message_id, status, created_at)
         VALUES (?1, ?2, 'running', ?3)",
        params![id, user_message_id, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

fn append_agent_event(path: &Path, run_id: &str, event: &AgentEvent) -> Result<()> {
    let event_type = match event {
        AgentEvent::ToolCall { .. } => "tool_call",
        AgentEvent::ToolResult { .. } => "tool_result",
        AgentEvent::Context { .. } => "context",
        AgentEvent::Complete { .. } => "complete",
        AgentEvent::Error { .. } => "error",
    };
    open_db(path)?.execute(
        "INSERT INTO agent_events (run_id, event_type, payload, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            run_id,
            event_type,
            serde_json::to_string(event)?,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn finish_agent_run(path: &Path, id: &str, status: &str) -> Result<()> {
    open_db(path)?.execute(
        "UPDATE agent_runs SET status = ?1, completed_at = ?2 WHERE id = ?3",
        params![status, chrono::Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

fn load_conversation_state(path: &Path) -> Result<ConversationState> {
    let connection = open_db(path)?;
    let messages = load_conversation(path)?;
    let mut runs = connection
        .prepare("SELECT id, user_message_id, status FROM agent_runs ORDER BY created_at, id")?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, user_message_id, status)| {
            let events = connection
                .prepare("SELECT payload FROM agent_events WHERE run_id = ?1 ORDER BY id")?
                .query_map([&id], |row| row.get::<_, String>(0))?
                .map(|event| Ok(serde_json::from_str::<AgentEvent>(&event?)?))
                .collect::<Result<Vec<_>>>()?;
            Ok(ConversationRun {
                id,
                user_message_id,
                status,
                events,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    runs.shrink_to_fit();
    Ok(ConversationState { messages, runs })
}

async fn send_agent_event(
    db_path: &Path,
    sink: &AgentEventSink<'_>,
    event: AgentEvent,
) -> Result<()> {
    append_agent_event(db_path, sink.run_id, &event)?;
    let _ = sink.sender.send(event).await;
    Ok(())
}

fn ensure_conversation_metadata_columns(connection: &Connection) -> Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(conversation_messages)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, definition) in [
        ("duration_ms", "INTEGER"),
        ("input_tokens", "INTEGER"),
        ("output_tokens", "INTEGER"),
        ("images", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute_batch(&format!(
                "ALTER TABLE conversation_messages ADD COLUMN {name} {definition}"
            ))?;
        }
    }
    Ok(())
}

fn load_work_graph(path: &Path) -> Result<WorkGraph> {
    let connection = open_db(path)?;
    let items = connection
        .prepare(
            "SELECT id, parent_id, title, description, status, evidence_text, delivery_text, created_at, updated_at
             FROM work_items ORDER BY id",
        )?
        .query_map([], |row| {
            Ok(WorkItem {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                status: row.get(4)?,
                evidence_text: row.get(5)?,
                delivery_text: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let dependencies = connection
        .prepare(
            "SELECT work_item_id, depends_on_id FROM work_item_dependencies
             ORDER BY work_item_id, depends_on_id",
        )?
        .query_map([], |row| {
            Ok(WorkItemDependency {
                work_item_id: row.get(0)?,
                depends_on_id: row.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let ready_ids = connection
        .prepare(
            "SELECT item.id FROM work_items item
             WHERE item.status = 'ready'
             AND NOT EXISTS (
               SELECT 1 FROM work_item_dependencies dependency
               JOIN work_items prerequisite ON prerequisite.id = dependency.depends_on_id
               WHERE dependency.work_item_id = item.id
               AND prerequisite.status <> 'satisfied'
             )
             ORDER BY item.id",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(WorkGraph {
        items,
        dependencies,
        ready_ids,
    })
}

fn valid_work_item_status(status: &str) -> bool {
    matches!(
        status,
        "ready" | "running" | "waiting" | "satisfied" | "superseded" | "cancelled"
    )
}

fn validate_work_item(title: &str, status: &str, evidence_text: &str) -> Result<()> {
    if title.trim().is_empty() {
        return Err(anyhow!("work item title cannot be empty"));
    }
    if !valid_work_item_status(status) {
        return Err(anyhow!("invalid work item status"));
    }
    if status == "satisfied" && evidence_text.trim().is_empty() {
        return Err(anyhow!("satisfied work items require evidence_text"));
    }
    Ok(())
}

fn work_item_exists(connection: &Connection, id: i64) -> Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM work_items WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn work_item_parent_has_cycle(connection: &Connection, id: i64) -> Result<bool> {
    connection
        .query_row(
            "WITH RECURSIVE ancestors(id) AS (
               SELECT parent_id FROM work_items WHERE id = ?1 AND parent_id IS NOT NULL
               UNION
               SELECT item.parent_id FROM work_items item
               JOIN ancestors ON item.id = ancestors.id
               WHERE item.parent_id IS NOT NULL
             )
             SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?1)",
            [id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn dependency_creates_cycle(
    connection: &Connection,
    work_item_id: i64,
    depends_on_id: i64,
) -> Result<bool> {
    connection
        .query_row(
            "WITH RECURSIVE prerequisites(id) AS (
               SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id = ?1
               UNION
               SELECT dependency.depends_on_id FROM work_item_dependencies dependency
               JOIN prerequisites ON dependency.work_item_id = prerequisites.id
             )
             SELECT EXISTS(SELECT 1 FROM prerequisites WHERE id = ?2)",
            params![depends_on_id, work_item_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn replace_work_item_dependencies(
    connection: &Connection,
    work_item_id: i64,
    depends_on_ids: &[i64],
) -> Result<()> {
    let mut ids = depends_on_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    connection.execute(
        "DELETE FROM work_item_dependencies WHERE work_item_id = ?1",
        [work_item_id],
    )?;
    for depends_on_id in ids {
        if work_item_id == depends_on_id || !work_item_exists(connection, depends_on_id)? {
            return Err(anyhow!("invalid work item dependency"));
        }
        if dependency_creates_cycle(connection, work_item_id, depends_on_id)? {
            return Err(anyhow!("work item dependency would create a cycle"));
        }
        connection.execute(
            "INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (?1, ?2)",
            params![work_item_id, depends_on_id],
        )?;
    }
    Ok(())
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
         );
         CREATE TABLE IF NOT EXISTS conversation_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
           content TEXT NOT NULL,
           created_at TEXT NOT NULL,
           duration_ms INTEGER,
           input_tokens INTEGER,
           output_tokens INTEGER,
           images TEXT
         );
         CREATE TABLE IF NOT EXISTS agent_runs (
           id TEXT PRIMARY KEY,
           user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id),
           status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
           created_at TEXT NOT NULL,
           completed_at TEXT
         );
         CREATE TABLE IF NOT EXISTS agent_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
           event_type TEXT NOT NULL CHECK(event_type IN ('tool_call', 'tool_result', 'context', 'complete', 'error')),
           payload TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS agent_events_run_id ON agent_events(run_id);
         CREATE TABLE IF NOT EXISTS work_items (
           id INTEGER PRIMARY KEY,
           parent_id INTEGER REFERENCES work_items(id),
           title TEXT NOT NULL,
           description TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL CHECK(status IN ('ready', 'running', 'waiting', 'satisfied', 'superseded', 'cancelled')) DEFAULT 'ready',
           evidence_text TEXT NOT NULL DEFAULT '',
           delivery_text TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS work_item_dependencies (
           work_item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
           depends_on_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
           PRIMARY KEY (work_item_id, depends_on_id),
           CHECK(work_item_id <> depends_on_id)
         );
         CREATE INDEX IF NOT EXISTS work_item_dependencies_depends_on_id
           ON work_item_dependencies(depends_on_id);",
    )?;
    ensure_conversation_metadata_columns(&connection)?;
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
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('toolset_filesystem_enabled', 'true')
         ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('toolset_bash_enabled', 'true')
         ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('toolset_web_search_enabled', 'true')
         ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('toolset_image_generation_enabled', 'true')
         ON CONFLICT(key) DO NOTHING",
        [],
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
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
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
        filesystem_tools_enabled: required("toolset_filesystem_enabled")?.parse()?,
        bash_tools_enabled: required("toolset_bash_enabled")?.parse()?,
        web_search_enabled: required("toolset_web_search_enabled")?.parse()?,
        image_generation_enabled: required("toolset_image_generation_enabled")?.parse()?,
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
        openai_base_url: config.openai_base_url,
        openai_api_key: config.openai_api_key,
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
    let openai_base_url = input.openai_base_url.trim().trim_end_matches('/');
    Url::parse(openai_base_url).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "openai_base_url must be an absolute URL",
        )
    })?;
    let openai_api_key = input.openai_api_key.trim();
    if openai_api_key.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "openai_api_key cannot be empty",
        ));
    }
    let mut connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let transaction = connection
        .transaction()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    transaction
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('default_model', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [default_model],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    transaction
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('openai_base_url', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [openai_base_url],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    transaction
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('openai_api_key', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [openai_api_key],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    transaction
        .commit()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    Ok(Json(SettingsResponse {
        default_model: default_model.to_owned(),
        openai_base_url: openai_base_url.to_owned(),
        openai_api_key: openai_api_key.to_owned(),
    }))
}

async fn toolsets(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<ToolsetsResponse> {
    identity(&state, &headers).await?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    Ok(Json(ToolsetsResponse {
        filesystem_enabled: config.filesystem_tools_enabled,
        bash_enabled: config.bash_tools_enabled,
        web_search_enabled: config.web_search_enabled,
        image_generation_enabled: config.image_generation_enabled,
    }))
}

async fn skills(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<SkillsResponse> {
    identity(&state, &headers).await?;
    let skills = state
        .skills
        .read()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read skills"))?
        .skills
        .clone();
    Ok(Json(SkillsResponse {
        directory: state.skills_directory.to_string_lossy().into_owned(),
        skills,
    }))
}

async fn update_toolsets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateToolsets>,
) -> ApiResult<ToolsetsResponse> {
    identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('toolset_filesystem_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [input.filesystem_enabled.to_string()],
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot save toolset configuration",
            )
        })?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('toolset_bash_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [input.bash_enabled.to_string()],
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot save toolset configuration",
            )
        })?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('toolset_web_search_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [input.web_search_enabled.to_string()],
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot save toolset configuration",
            )
        })?;
    connection
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('toolset_image_generation_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [input.image_generation_enabled.to_string()],
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot save toolset configuration",
            )
        })?;
    Ok(Json(ToolsetsResponse {
        filesystem_enabled: input.filesystem_enabled,
        bash_enabled: input.bash_enabled,
        web_search_enabled: input.web_search_enabled,
        image_generation_enabled: input.image_generation_enabled,
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

async fn update_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<update::UpdateStatus> {
    identity(&state, &headers).await?;
    let status = update::status(&state.db_path)
        .map_err(|cause| error(StatusCode::INTERNAL_SERVER_ERROR, cause.to_string()))?;
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

async fn conversation(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<ConversationState> {
    identity(&state, &headers).await?;
    let conversation = load_conversation_state(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read conversation",
        )
    })?;
    Ok(Json(conversation))
}

async fn work_graph(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<WorkGraph> {
    identity(&state, &headers).await?;
    load_work_graph(&state.db_path)
        .map(Json)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read work graph"))
}

async fn create_work_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateWorkItem>,
) -> ApiResult<WorkGraph> {
    identity(&state, &headers).await?;
    validate_work_item(&input.title, &input.status, &input.evidence_text)
        .map_err(|cause| error(StatusCode::BAD_REQUEST, cause.to_string()))?;
    let mut connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let transaction = connection
        .transaction()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot create work item"))?;
    if let Some(parent_id) = input.parent_id
        && !work_item_exists(&transaction, parent_id).map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot validate work item",
            )
        })?
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "work item parent does not exist",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT INTO work_items (parent_id, title, description, status, evidence_text, delivery_text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                input.parent_id,
                input.title.trim(),
                input.description,
                input.status,
                input.evidence_text,
                input.delivery_text,
                now,
            ],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot create work item"))?;
    let id = transaction.last_insert_rowid();
    if work_item_parent_has_cycle(&transaction, id).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot validate work item",
        )
    })? {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "work item parent would create a cycle",
        ));
    }
    replace_work_item_dependencies(&transaction, id, &input.depends_on_ids)
        .map_err(|cause| error(StatusCode::BAD_REQUEST, cause.to_string()))?;
    transaction
        .commit()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot create work item"))?;
    load_work_graph(&state.db_path)
        .map(Json)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read work graph"))
}

async fn update_work_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<UpdateWorkItem>,
) -> ApiResult<WorkGraph> {
    identity(&state, &headers).await?;
    validate_work_item(&input.title, &input.status, &input.evidence_text)
        .map_err(|cause| error(StatusCode::BAD_REQUEST, cause.to_string()))?;
    let mut connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let transaction = connection
        .transaction()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot update work item"))?;
    if !work_item_exists(&transaction, id).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot validate work item",
        )
    })? {
        return Err(error(StatusCode::NOT_FOUND, "work item does not exist"));
    }
    if let Some(parent_id) = input.parent_id
        && !work_item_exists(&transaction, parent_id).map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot validate work item",
            )
        })?
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "work item parent does not exist",
        ));
    }
    transaction
        .execute(
            "UPDATE work_items
             SET parent_id = ?1, title = ?2, description = ?3, status = ?4,
                 evidence_text = ?5, delivery_text = ?6, updated_at = ?7
             WHERE id = ?8",
            params![
                input.parent_id,
                input.title.trim(),
                input.description,
                input.status,
                input.evidence_text,
                input.delivery_text,
                chrono::Utc::now().to_rfc3339(),
                id,
            ],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot update work item"))?;
    if work_item_parent_has_cycle(&transaction, id).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot validate work item",
        )
    })? {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "work item parent would create a cycle",
        ));
    }
    replace_work_item_dependencies(&transaction, id, &input.depends_on_ids)
        .map_err(|cause| error(StatusCode::BAD_REQUEST, cause.to_string()))?;
    transaction
        .commit()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot update work item"))?;
    load_work_graph(&state.db_path)
        .map(Json)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read work graph"))
}

async fn transcribe_audio(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<TranscriptionResponse> {
    identity(&state, &headers).await?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    let field = multipart
        .next_field()
        .await
        .map_err(|_| error(StatusCode::BAD_REQUEST, "cannot read audio"))?
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "audio is required"))?;
    if field.name() != Some("file") {
        return Err(error(StatusCode::BAD_REQUEST, "audio is required"));
    }
    let file_name = field.file_name().unwrap_or("recording.webm").to_owned();
    let content_type = field.content_type().unwrap_or("audio/webm").to_owned();
    let bytes = field
        .bytes()
        .await
        .map_err(|_| error(StatusCode::BAD_REQUEST, "cannot read audio"))?;
    let file = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name)
        .mime_str(&content_type)
        .map_err(|_| error(StatusCode::BAD_REQUEST, "cannot read audio"))?;
    let form = reqwest::multipart::Form::new()
        .text("model", "gpt-transcribe")
        .part("file", file);
    let response = state
        .client
        .post(format!("{}/audio/transcriptions", config.openai_base_url))
        .bearer_auth(config.openai_api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "cannot transcribe audio"))?
        .error_for_status()
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "cannot transcribe audio"))?
        .json::<Value>()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "invalid transcription response"))?;
    Ok(Json(TranscriptionResponse {
        text: transcription_text(&response)
            .map_err(|_| error(StatusCode::BAD_GATEWAY, "invalid transcription response"))?,
    }))
}

async fn agent_turn(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AgentTurn>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    identity(&state, &headers).await?;
    if input.message.role != "user" || input.message.content.as_str().is_none_or(str::is_empty) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "agent turns require a non-empty user message",
        ));
    }
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    let user_message = append_conversation(&state.db_path, &input.message, None).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot save conversation message",
        )
    })?;
    create_agent_run(&state.db_path, &input.run_id, user_message.id)
        .map_err(|_| error(StatusCode::CONFLICT, "agent run already exists"))?;
    let messages = conversation_context(load_conversation(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read conversation",
        )
    })?);
    let client = state.client.clone();
    let db_path = state.db_path.clone();
    let skills = state.skills.clone();
    let active_runs = state.active_runs.clone();
    let run_id = input.run_id.clone();
    let (cancel, cancellation) = watch::channel(false);
    active_runs.lock().await.insert(run_id.clone(), cancel);
    let (events, receiver) = mpsc::channel(32);
    let started_at = Instant::now();
    tokio::spawn(async move {
        let event = match run_agent(
            &client,
            &config,
            messages,
            &db_path,
            &skills,
            AgentEventSink {
                run_id: &run_id,
                sender: &events,
            },
            cancellation,
        )
        .await
        {
            Ok(result) => {
                let usage = AgentUsage {
                    duration_ms: started_at.elapsed().as_millis() as u64,
                    input_tokens: result.input_tokens,
                    output_tokens: result.output_tokens,
                };
                match append_conversation(&db_path, &result.message, Some(usage)) {
                    Ok(message) => AgentEvent::Complete { message },
                    Err(cause) => AgentEvent::Error {
                        error: format!("cannot save assistant message: {cause}"),
                    },
                }
            }
            Err(cause) => AgentEvent::Error {
                error: cause.to_string(),
            },
        };
        let status = match &event {
            AgentEvent::Complete { .. } => "completed",
            AgentEvent::Error { error } if error == "agent stopped" => "cancelled",
            AgentEvent::Error { .. } => "failed",
            _ => unreachable!("agent runs always end with a terminal event"),
        };
        let _ = send_agent_event(
            &db_path,
            &AgentEventSink {
                run_id: &run_id,
                sender: &events,
            },
            event,
        )
        .await;
        let _ = finish_agent_run(&db_path, &run_id, status);
        active_runs.lock().await.remove(&run_id);
    });
    let stream = ReceiverStream::new(receiver).map(|event| {
        Ok::<_, Infallible>(Event::default().data(serde_json::to_string(&event).unwrap()))
    });
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

async fn cancel_agent_turn(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    identity(&state, &headers).await?;
    if let Some(cancel) = state.active_runs.lock().await.get(&id) {
        let _ = cancel.send(true);
    }
    Ok(Json(json!({"cancelled": true})))
}

async fn run_agent(
    client: &reqwest::Client,
    config: &Config,
    messages: Vec<ChatMessage>,
    db_path: &Path,
    skills: &Arc<StdRwLock<SkillCatalog>>,
    events: AgentEventSink<'_>,
    mut cancellation: watch::Receiver<bool>,
) -> Result<AgentResult> {
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut items = messages
        .into_iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect::<Vec<_>>();
    loop {
        if *cancellation.borrow() {
            return Err(anyhow!("agent stopped"));
        }
        let request = client
            .post(format!("{}/responses", config.openai_base_url))
            .bearer_auth(&config.openai_api_key)
            .json(&responses_request_body(
                &config.default_model,
                &items,
                config.filesystem_tools_enabled,
                config.bash_tools_enabled,
                config.web_search_enabled,
                config.image_generation_enabled,
                &skills
                    .read()
                    .map_err(|_| anyhow!("cannot read skills"))?
                    .clone(),
            ));
        let response = tokio::select! {
            response = request.send() => response?,
            _ = cancellation.changed() => return Err(anyhow!("agent stopped")),
        }
        .error_for_status()?;
        let response = tokio::select! {
            body = response.text() => body?,
            _ = cancellation.changed() => return Err(anyhow!("agent stopped")),
        };
        let response = completed_response_from_sse(&response)?;
        if let Some(response_input_tokens) = response
            .pointer("/usage/input_tokens")
            .and_then(Value::as_u64)
        {
            input_tokens += response_input_tokens;
            send_agent_event(
                db_path,
                &events,
                AgentEvent::Context {
                    input_tokens: response_input_tokens,
                },
            )
            .await?;
        }
        output_tokens += response
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let output = response
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| anyhow!("upstream returned no Responses output"))?;
        let images = generated_images(&output);
        emit_response_process_events(&output, db_path, &events).await?;
        let calls = output
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
            .cloned()
            .collect::<Vec<_>>();
        if calls.is_empty() {
            return Ok(AgentResult {
                message: ChatMessage {
                    role: "assistant".to_owned(),
                    content: Value::String(output_text(&output)),
                    images: (!images.is_empty()).then_some(images),
                    tool_call_id: None,
                    tool_calls: None,
                },
                input_tokens,
                output_tokens,
            });
        }
        items.extend(response_output_for_input(output));
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
            send_agent_event(
                db_path,
                &events,
                AgentEvent::ToolCall {
                    call_id: call_id.to_owned(),
                    name: name.to_owned(),
                    arguments: args.clone(),
                },
            )
            .await?;
            let execution = execute_tool(name, args, db_path, cancellation.clone()).await;
            send_agent_event(
                db_path,
                &events,
                AgentEvent::ToolResult {
                    call_id: call_id.to_owned(),
                    name: name.to_owned(),
                    added_lines: execution.added_lines,
                    deleted_lines: execution.deleted_lines,
                },
            )
            .await?;
            items.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": execution.output,
            }));
        }
    }
}

fn response_output_for_input(output: Vec<Value>) -> Vec<Value> {
    output
        .into_iter()
        .map(|mut item| match item.get("type").and_then(Value::as_str) {
            Some("web_search_call") => {
                // COMPATIBILITY: Some OpenAI-compatible upstreams reject the output-only
                // `action` field when a web-search item is replayed through `input`.
                // Remove this once their Responses input schema accepts this fixture.
                item.as_object_mut()
                    .expect("a JSON value with type is an object")
                    .remove("action");
                item
            }
            Some("image_generation_call") => {
                // COMPATIBILITY: Some OpenAI-compatible upstreams reject the generated
                // image `result` during replay. The Responses API accepts an image-call ID
                // reference for follow-up edits. Remove this once full output replay works.
                json!({"type":"image_generation_call","id":item.get("id").expect("image generation call has an id")})
            }
            _ => item,
        })
        .collect()
}

fn responses_request_body(
    model: &str,
    input: &[Value],
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
    skills: &SkillCatalog,
) -> Value {
    let mut body = json!({
        "model": model,
        "input": input,
        "store": false,
        "stream": true,
        "reasoning": { "summary": "auto" },
        "instructions": skill_instructions(skills),
    });
    let tools = tool_definitions(
        filesystem_tools_enabled,
        bash_tools_enabled,
        web_search_enabled,
        image_generation_enabled,
    );
    if !tools
        .as_array()
        .expect("tool definitions are an array")
        .is_empty()
    {
        body["tools"] = tools;
        body["tool_choice"] = Value::String("auto".to_owned());
    }
    body
}

fn skill_instructions(skills: &SkillCatalog) -> String {
    let metadata = serde_json::to_string(&skills.skills).expect("skill metadata is serializable");
    format!(
        "Work Items are Mobius's persistent delivery graph. For a user request that has a deliverable or needs sustained execution, inspect it with get_work_graph, then create or update Work Items to represent the work. Use parent_id for the work-breakdown tree and depends_on_ids for prerequisites. Keep status accurate: ready, running, waiting, satisfied, superseded, or cancelled. Only mark an item satisfied when evidence_text is non-empty; record the resulting artifact or outcome in delivery_text. Before updating an item, inspect the graph and send every required field back to update_work_item. Do not create Work Items for casual questions with no delivery.\nInstalled SKILL metadata is refreshed before every API request. When you choose a skill, first read its SKILL.md with the read_file tool, then follow it. The directory field is the skill installation directory and can be used to read files referenced by SKILL.md.\n{metadata}"
    )
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

fn generated_images(output: &[Value]) -> Vec<GeneratedImage> {
    output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("image_generation_call"))
        .filter_map(|item| {
            Some(GeneratedImage {
                id: item.get("id")?.as_str()?.to_owned(),
                data: item.get("result")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

fn reasoning_parameters(item: &Value) -> Value {
    json!({ "summary": item.get("summary").cloned().unwrap_or_default() })
}

async fn emit_response_process_events(
    output: &[Value],
    db_path: &Path,
    events: &AgentEventSink<'_>,
) -> Result<()> {
    for item in output {
        let response_type = item.get("type").and_then(Value::as_str);
        let (name, arguments) = match response_type {
            Some("reasoning") => ("reasoning", reasoning_parameters(item)),
            Some("web_search_call") => (
                "web_search",
                item.get("action").cloned().unwrap_or_else(|| json!({})),
            ),
            Some("image_generation_call") => ("image_generation", json!({})),
            _ => continue,
        };
        let call_id = item
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("{name} output item has no id"))?;
        send_agent_event(
            db_path,
            events,
            AgentEvent::ToolCall {
                call_id: call_id.to_owned(),
                name: name.to_owned(),
                arguments,
            },
        )
        .await?;
        send_agent_event(
            db_path,
            events,
            AgentEvent::ToolResult {
                call_id: call_id.to_owned(),
                name: name.to_owned(),
                added_lines: None,
                deleted_lines: None,
            },
        )
        .await?;
    }
    Ok(())
}

fn transcription_text(response: &Value) -> Result<String> {
    response
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("transcription response has no text"))
}

fn tool_definitions(
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
) -> Value {
    let mut tools = vec![
        json!({"type":"function","name":"get_work_graph","description":"Read Mobius's persistent Work Item graph, including every item, its parent tree, dependency edges, and the currently unblocked ready_ids.","parameters":{"type":"object","additionalProperties":false,"properties":{}}}),
        json!({"type":"function","name":"create_work_item","description":"Create a persistent Work Item for a delivery objective or a bounded part of it. Use parent_id for the work-breakdown tree and depends_on_ids for prerequisites.","parameters":{"type":"object","additionalProperties":false,"required":["title"],"properties":{"parent_id":{"type":["integer","null"]},"title":{"type":"string"},"description":{"type":"string"},"status":{"type":"string","enum":["ready","running","waiting","satisfied","superseded","cancelled"]},"evidence_text":{"type":"string"},"delivery_text":{"type":"string"},"depends_on_ids":{"type":"array","items":{"type":"integer"}}}}}),
        json!({"type":"function","name":"update_work_item","description":"Replace a Work Item's fields and dependencies. First call get_work_graph, then provide every field exactly as it should remain. A satisfied item requires non-empty evidence_text.","parameters":{"type":"object","additionalProperties":false,"required":["id","parent_id","title","description","status","evidence_text","delivery_text","depends_on_ids"],"properties":{"id":{"type":"integer"},"parent_id":{"type":["integer","null"]},"title":{"type":"string"},"description":{"type":"string"},"status":{"type":"string","enum":["ready","running","waiting","satisfied","superseded","cancelled"]},"evidence_text":{"type":"string"},"delivery_text":{"type":"string"},"depends_on_ids":{"type":"array","items":{"type":"integer"}}}}}),
    ];
    if filesystem_tools_enabled {
        tools.extend([
            json!({"type":"function","name":"list_files","description":"List files in any directory on this machine.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"}}}}),
            json!({"type":"function","name":"read_file","description":"Read a file from any path on this machine. Binary files are returned as base64 JSON.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"}}}}),
            json!({"type":"function","name":"write_file","description":"Write a UTF-8 text file to any existing path on this machine.","parameters":{"type":"object","additionalProperties":false,"required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"}}}}),
            json!({"type":"function","name":"edit_file","description":"Partially edit a UTF-8 text file by replacing one exact old_text match with new_text. Use this after reading the file; old_text must occur exactly once.","parameters":{"type":"object","additionalProperties":false,"required":["path","old_text","new_text"],"properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"}}}}),
        ]);
    }
    if bash_tools_enabled {
        tools.push(json!({"type":"function","name":"run_bash","description":"Execute a Bash command on this Mobius machine. Return stdout, stderr, and the exit status.","parameters":{"type":"object","additionalProperties":false,"required":["command"],"properties":{"command":{"type":"string"}}}}));
    }
    if web_search_enabled {
        tools.push(json!({"type":"web_search"}));
    }
    if image_generation_enabled {
        tools.push(json!({"type":"image_generation"}));
    }
    Value::Array(tools)
}

struct ToolExecution {
    output: String,
    added_lines: Option<usize>,
    deleted_lines: Option<usize>,
}

fn tool_execution(output: impl Into<String>) -> ToolExecution {
    ToolExecution {
        output: output.into(),
        added_lines: None,
        deleted_lines: None,
    }
}

fn line_change_counts(previous: &str, next: &str) -> (usize, usize) {
    let previous = previous.lines().collect::<Vec<_>>();
    let next = next.lines().collect::<Vec<_>>();
    TextDiff::from_slices(&previous, &next)
        .iter_all_changes()
        .fold((0, 0), |(added, deleted), change| match change.tag() {
            ChangeTag::Insert => (added + 1, deleted),
            ChangeTag::Delete => (added, deleted + 1),
            ChangeTag::Equal => (added, deleted),
        })
}

async fn execute_tool(
    name: &str,
    args: Value,
    db_path: &Path,
    cancellation: watch::Receiver<bool>,
) -> ToolExecution {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    match name {
        "get_work_graph" => load_work_graph(db_path)
            .and_then(|graph| serde_json::to_string(&graph).map_err(Into::into))
            .map(tool_execution)
            .unwrap_or_else(|cause| tool_execution(format!("error: {cause}"))),
        "create_work_item" => execute_create_work_item(db_path, args),
        "update_work_item" => execute_update_work_item(db_path, args),
        "list_files" => match std::fs::read_dir(path) {
            Ok(entries) => tool_execution(
                serde_json::to_string(
                    &entries
                        .filter_map(std::result::Result::ok)
                        .map(|entry| entry.path().display().to_string())
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
            ),
            Err(error) => tool_execution(format!("error: {error}")),
        },
        "read_file" => tool_execution(
            std::fs::read(path)
                .map(|bytes| match String::from_utf8(bytes) {
                    Ok(content) => content,
                    Err(error) => {
                        json!({"encoding":"base64","content":BASE64.encode(error.into_bytes())})
                            .to_string()
                    }
                })
                .unwrap_or_else(|error| format!("error: {error}")),
        ),
        "write_file" => execute_write_file(
            path,
            args.get("content").and_then(Value::as_str).unwrap_or(""),
        ),
        "edit_file" => execute_edit_file(
            path,
            args.get("old_text").and_then(Value::as_str).unwrap_or(""),
            args.get("new_text").and_then(Value::as_str).unwrap_or(""),
        ),
        "run_bash" => tool_execution(run_bash(args, cancellation).await),
        _ => tool_execution("error: unknown tool"),
    }
}

fn execute_create_work_item(db_path: &Path, args: Value) -> ToolExecution {
    let input = match serde_json::from_value::<CreateWorkItem>(args) {
        Ok(input) => input,
        Err(cause) => return tool_execution(format!("error: invalid Work Item: {cause}")),
    };
    create_work_item_for_agent(db_path, input)
        .and_then(|graph| serde_json::to_string(&graph).map_err(Into::into))
        .map(tool_execution)
        .unwrap_or_else(|cause| tool_execution(format!("error: {cause}")))
}

fn execute_update_work_item(db_path: &Path, mut args: Value) -> ToolExecution {
    let id = match args.get("id").and_then(Value::as_i64) {
        Some(id) => id,
        None => return tool_execution("error: update_work_item requires an integer id"),
    };
    let Some(arguments) = args.as_object_mut() else {
        return tool_execution("error: update_work_item arguments must be an object");
    };
    arguments.remove("id");
    let input = match serde_json::from_value::<UpdateWorkItem>(args) {
        Ok(input) => input,
        Err(cause) => return tool_execution(format!("error: invalid Work Item: {cause}")),
    };
    update_work_item_for_agent(db_path, id, input)
        .and_then(|graph| serde_json::to_string(&graph).map_err(Into::into))
        .map(tool_execution)
        .unwrap_or_else(|cause| tool_execution(format!("error: {cause}")))
}

fn create_work_item_for_agent(db_path: &Path, input: CreateWorkItem) -> Result<WorkGraph> {
    validate_work_item(&input.title, &input.status, &input.evidence_text)?;
    let mut connection = open_db(db_path)?;
    let transaction = connection.transaction()?;
    if let Some(parent_id) = input.parent_id
        && !work_item_exists(&transaction, parent_id)?
    {
        return Err(anyhow!("work item parent does not exist"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO work_items (parent_id, title, description, status, evidence_text, delivery_text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            input.parent_id,
            input.title.trim(),
            input.description,
            input.status,
            input.evidence_text,
            input.delivery_text,
            now,
        ],
    )?;
    let id = transaction.last_insert_rowid();
    if work_item_parent_has_cycle(&transaction, id)? {
        return Err(anyhow!("work item parent would create a cycle"));
    }
    replace_work_item_dependencies(&transaction, id, &input.depends_on_ids)?;
    transaction.commit()?;
    load_work_graph(db_path)
}

fn update_work_item_for_agent(db_path: &Path, id: i64, input: UpdateWorkItem) -> Result<WorkGraph> {
    validate_work_item(&input.title, &input.status, &input.evidence_text)?;
    let mut connection = open_db(db_path)?;
    let transaction = connection.transaction()?;
    if !work_item_exists(&transaction, id)? {
        return Err(anyhow!("work item does not exist"));
    }
    if let Some(parent_id) = input.parent_id
        && !work_item_exists(&transaction, parent_id)?
    {
        return Err(anyhow!("work item parent does not exist"));
    }
    transaction.execute(
        "UPDATE work_items
         SET parent_id = ?1, title = ?2, description = ?3, status = ?4,
             evidence_text = ?5, delivery_text = ?6, updated_at = ?7
         WHERE id = ?8",
        params![
            input.parent_id,
            input.title.trim(),
            input.description,
            input.status,
            input.evidence_text,
            input.delivery_text,
            chrono::Utc::now().to_rfc3339(),
            id,
        ],
    )?;
    if work_item_parent_has_cycle(&transaction, id)? {
        return Err(anyhow!("work item parent would create a cycle"));
    }
    replace_work_item_dependencies(&transaction, id, &input.depends_on_ids)?;
    transaction.commit()?;
    load_work_graph(db_path)
}

fn execute_write_file(path: &str, content: &str) -> ToolExecution {
    let previous = std::fs::read_to_string(path).ok();
    save_file(path, previous.as_deref(), content, "written")
}

fn execute_edit_file(path: &str, old_text: &str, new_text: &str) -> ToolExecution {
    if old_text.is_empty() {
        return tool_execution("error: old_text must not be empty");
    }
    let previous = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => return tool_execution(format!("error: {error}")),
    };
    match previous.match_indices(old_text).count() {
        0 => tool_execution("error: old_text was not found"),
        1 => save_file(
            path,
            Some(&previous),
            &previous.replacen(old_text, new_text, 1),
            "edited",
        ),
        count => tool_execution(format!(
            "error: old_text occurs {count} times; provide a unique match"
        )),
    }
}

fn save_file(path: &str, previous: Option<&str>, content: &str, output: &str) -> ToolExecution {
    match std::fs::write(path, content) {
        Ok(()) => {
            let (added_lines, deleted_lines) = previous
                .map(|previous| line_change_counts(previous, content))
                .unwrap_or((content.lines().count(), 0));
            ToolExecution {
                output: output.to_owned(),
                added_lines: Some(added_lines),
                deleted_lines: Some(deleted_lines),
            }
        }
        Err(error) => tool_execution(format!("error: {error}")),
    }
}

async fn run_bash(args: Value, mut cancellation: watch::Receiver<bool>) -> String {
    let Some(command) = args.get("command").and_then(Value::as_str) else {
        return "error: missing bash command".to_owned();
    };
    if *cancellation.borrow() {
        return "error: command cancelled".to_owned();
    }
    let output = Command::new("bash")
        .args(["-lc", command])
        .kill_on_drop(true)
        .output();
    tokio::select! {
        result = output => match result {
            Ok(output) => json!({
                "stdout": String::from_utf8_lossy(&output.stdout),
                "stderr": String::from_utf8_lossy(&output.stderr),
                "exit_code": output.status.code(),
            }).to_string(),
            Err(error) => format!("error: cannot run bash: {error}"),
        },
        _ = cancellation.changed() => "error: command cancelled".to_owned(),
        _ = tokio::time::sleep(Duration::from_secs(60)) => "error: command timed out after 60 seconds".to_owned(),
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
        let bash_enabled: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'toolset_bash_enabled'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bash_enabled, "true");
        let web_search_enabled: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'toolset_web_search_enabled'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(web_search_enabled, "true");
        let image_generation_enabled: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'toolset_image_generation_enabled'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(image_generation_enabled, "true");
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
    fn conversation_messages_are_stored_in_one_ordered_sequence() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        for (role, content) in [("user", "hello"), ("assistant", "hi")] {
            append_conversation(
                &db,
                &ChatMessage {
                    role: role.to_owned(),
                    content: Value::String(content.to_owned()),
                    images: None,
                    tool_call_id: None,
                    tool_calls: None,
                },
                None,
            )
            .unwrap();
        }
        let messages = load_conversation(&db).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].content, "hi");
    }

    #[test]
    fn conversation_state_restores_persisted_agent_events() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("inspect the project".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "run_1", user.id).unwrap();
        append_agent_event(
            &db,
            "run_1",
            &AgentEvent::ToolCall {
                call_id: "call_1".to_owned(),
                name: "read_file".to_owned(),
                arguments: json!({"path": "/project/README.md"}),
            },
        )
        .unwrap();
        append_agent_event(
            &db,
            "run_1",
            &AgentEvent::ToolResult {
                call_id: "call_1".to_owned(),
                name: "read_file".to_owned(),
                added_lines: None,
                deleted_lines: None,
            },
        )
        .unwrap();
        let state = load_conversation_state(&db).unwrap();
        assert_eq!(state.messages[0].id, user.id);
        assert_eq!(state.runs.len(), 1);
        assert_eq!(state.runs[0].user_message_id, user.id);
        assert_eq!(state.runs[0].status, "running");
        assert!(matches!(
            state.runs[0].events[1],
            AgentEvent::ToolResult { ref name, .. } if name == "read_file"
        ));
    }

    #[test]
    fn conversation_metadata_is_added_to_existing_message_tables() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        let connection = open_db(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE conversation_messages (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   role TEXT NOT NULL,
                   content TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        drop(connection);
        bootstrap_database(&db).unwrap();
        append_conversation(
            &db,
            &ChatMessage {
                role: "assistant".to_owned(),
                content: Value::String("done".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            Some(AgentUsage {
                duration_ms: 1_250,
                input_tokens: 800,
                output_tokens: 200,
            }),
        )
        .unwrap();
        let message = load_conversation(&db).unwrap().pop().unwrap();
        assert_eq!(message.duration_ms, Some(1_250));
        assert_eq!(message.input_tokens, Some(800));
        assert_eq!(message.output_tokens, Some(200));
    }

    #[test]
    fn work_graph_exposes_the_unblocked_topological_frontier() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let connection = open_db(&db).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO work_items (title, status, evidence_text, delivery_text, created_at, updated_at)
                 VALUES ('Research', 'ready', '', 'research notes', ?1, ?1)",
                [&now],
            )
            .unwrap();
        let research_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO work_items (parent_id, title, status, evidence_text, delivery_text, created_at, updated_at)
                 VALUES (?1, 'Implement', 'ready', '', 'implementation', ?2, ?2)",
                params![research_id, now],
            )
            .unwrap();
        let implement_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (?1, ?2)",
                params![implement_id, research_id],
            )
            .unwrap();
        assert_eq!(load_work_graph(&db).unwrap().ready_ids, vec![research_id]);
        connection
            .execute(
                "UPDATE work_items SET status = 'satisfied', evidence_text = 'source reviewed' WHERE id = ?1",
                [research_id],
            )
            .unwrap();
        let graph = load_work_graph(&db).unwrap();
        assert_eq!(graph.ready_ids, vec![implement_id]);
        assert_eq!(
            graph
                .items
                .iter()
                .find(|item| item.id == implement_id)
                .unwrap()
                .delivery_text,
            "implementation"
        );
    }

    #[test]
    fn work_item_dependencies_reject_cycles_and_satisfied_items_need_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let connection = open_db(&db).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        for title in ["A", "B"] {
            connection
                .execute(
                    "INSERT INTO work_items (title, status, created_at, updated_at) VALUES (?1, 'ready', ?2, ?2)",
                    params![title, now],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (1, 2)",
                [],
            )
            .unwrap();
        assert!(replace_work_item_dependencies(&connection, 2, &[1]).is_err());
        assert!(validate_work_item("A", "satisfied", "").is_err());
    }

    #[test]
    fn work_item_tools_create_and_update_persistent_items() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let created = execute_create_work_item(
            &db,
            json!({"title":"Ship Work Item tools","description":"Expose the graph to the agent"}),
        );
        let graph: Value = serde_json::from_str(&created.output).unwrap();
        assert_eq!(graph["items"][0]["status"], "ready");
        let updated = execute_update_work_item(
            &db,
            json!({
                "id": 1,
                "parent_id": null,
                "title": "Ship Work Item tools",
                "description": "Expose the graph to the agent",
                "status": "satisfied",
                "evidence_text": "tool test passed",
                "delivery_text": "native Work Item tools",
                "depends_on_ids": []
            }),
        );
        let graph: Value = serde_json::from_str(&updated.output).unwrap();
        assert_eq!(graph["items"][0]["status"], "satisfied");
        assert_eq!(graph["items"][0]["delivery_text"], "native Work Item tools");
    }

    #[test]
    fn responses_body_uses_input_and_responses_function_schema() {
        let skills = SkillCatalog::default();
        let body = responses_request_body(
            "gpt-5",
            &[json!({"role":"user","content":"list files"})],
            true,
            false,
            false,
            false,
            &skills,
        );
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
        assert_eq!(
            body.pointer("/reasoning/summary").and_then(Value::as_str),
            Some("auto")
        );
    }

    #[test]
    fn disabled_toolsets_leave_the_core_work_item_tools_available() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
        );
        assert_eq!(
            body.get("tools").and_then(Value::as_array).unwrap().len(),
            3
        );
        assert_eq!(
            body.get("tool_choice").and_then(Value::as_str),
            Some("auto")
        );
    }

    #[test]
    fn skill_metadata_is_injected_with_its_installation_directory() {
        let skills = SkillCatalog {
            skills: vec![SkillMetadata {
                name: "release".to_owned(),
                description: "Release the application.".to_owned(),
                directory: "/skills/release".to_owned(),
            }],
        };
        let body = responses_request_body("gpt-5", &[], false, false, false, false, &skills);
        let instructions = body.get("instructions").and_then(Value::as_str).unwrap();
        assert!(instructions.contains("release"));
        assert!(instructions.contains("/skills/release"));
    }

    #[test]
    fn skill_loader_reads_frontmatter_from_skill_directories() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("release");
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            "---\nname: release\ndescription: Release the application.\n---\n",
        )
        .unwrap();
        let skills = load_skills(temp.path());
        assert_eq!(skills.skills.len(), 1);
        assert_eq!(skills.skills[0].name, "release");
        assert_eq!(skills.skills[0].description, "Release the application.");
        assert_eq!(skills.skills[0].directory, directory.to_string_lossy());
    }

    #[test]
    fn bash_toolset_adds_only_the_bash_tool_when_filesystem_is_disabled() {
        let tools = tool_definitions(false, true, false, false);
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), 4);
        assert_eq!(
            tools[3].get("name").and_then(Value::as_str),
            Some("run_bash")
        );
    }

    #[test]
    fn work_item_tools_and_instructions_are_always_available() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
        );
        let tools = body.get("tools").and_then(Value::as_array).unwrap();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "get_work_graph");
        assert_eq!(tools[1]["name"], "create_work_item");
        assert_eq!(tools[2]["name"], "update_work_item");
        assert!(
            body["instructions"]
                .as_str()
                .unwrap()
                .contains("Work Items")
        );
    }

    #[test]
    fn web_search_toolset_uses_the_native_responses_tool() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            true,
            false,
            &SkillCatalog::default(),
        );
        assert!(
            body.get("tools")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|tool| tool["type"] == "web_search")
        );
        assert_eq!(
            body.get("tool_choice").and_then(Value::as_str),
            Some("auto")
        );
    }

    #[test]
    fn responses_input_omits_web_search_actions() {
        let input = response_output_for_input(vec![
            json!({
                "type": "web_search_call",
                "id": "web_1",
                "status": "completed",
                "action": {"type": "search", "query": "Mobius"},
            }),
            json!({"type": "function_call", "call_id": "call_1"}),
        ]);
        assert!(input[0].get("action").is_none());
        assert_eq!(input[0]["id"], "web_1");
        assert_eq!(input[0]["status"], "completed");
        assert_eq!(input[1]["call_id"], "call_1");
    }

    #[test]
    fn responses_input_uses_image_generation_call_ids() {
        let input = response_output_for_input(vec![json!({
            "type": "image_generation_call",
            "id": "image_1",
            "status": "completed",
            "result": "aW1hZ2U=",
            "revised_prompt": "A Mobius logo.",
        })]);
        assert_eq!(
            input,
            vec![json!({"type":"image_generation_call","id":"image_1"})]
        );
    }

    #[test]
    fn image_generation_toolset_uses_the_native_responses_tool() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            true,
            &SkillCatalog::default(),
        );
        assert!(
            body.get("tools")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|tool| tool["type"] == "image_generation")
        );
    }

    #[test]
    fn image_generation_output_is_preserved_for_the_console() {
        let images = generated_images(&[json!({
            "type": "image_generation_call",
            "id": "image_1",
            "result": "aW1hZ2U=",
        })]);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].id, "image_1");
        assert_eq!(images[0].data, "aW1hZ2U=");
    }

    #[tokio::test]
    async fn response_process_events_include_web_search_and_reasoning_parameters() {
        let output = vec![
            json!({
                "type": "reasoning",
                "id": "reasoning_1",
                "summary": [{"type": "summary_text", "text": "Plan the search."}],
            }),
            json!({
                "type": "web_search_call",
                "id": "web_1",
                "action": {"type": "search", "query": "Mobius work graph"},
            }),
        ];
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("search".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "run_1", user.id).unwrap();
        let (events, mut received) = mpsc::channel(4);
        emit_response_process_events(
            &output,
            &db,
            &AgentEventSink {
                run_id: "run_1",
                sender: &events,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::ToolCall { name, arguments, .. })
                if name == "reasoning" && arguments["summary"][0]["text"] == "Plan the search."
        ));
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::ToolResult { name, .. }) if name == "reasoning"
        ));
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::ToolCall { name, arguments, .. })
                if name == "web_search" && arguments["query"] == "Mobius work graph"
        ));
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::ToolResult { name, .. }) if name == "web_search"
        ));
    }

    #[tokio::test]
    async fn bash_tool_returns_stdout_and_exit_status() {
        let result = run_bash(json!({"command":"printf hello"}), watch::channel(false).1).await;
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result.get("stdout").and_then(Value::as_str), Some("hello"));
        assert_eq!(result.get("exit_code").and_then(Value::as_i64), Some(0));
    }

    #[test]
    fn line_changes_report_the_replaced_middle_section() {
        assert_eq!(
            line_change_counts("first\nsecond\nthird", "first\nupdated\nthird\nfourth"),
            (2, 1)
        );
    }

    #[test]
    fn edit_file_replaces_one_unique_text_section() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), "first\nsecond\nthird\n").unwrap();
        let result = execute_edit_file(temp.path().to_str().unwrap(), "second", "updated");
        assert_eq!(result.output, "edited");
        assert_eq!(result.added_lines, Some(1));
        assert_eq!(result.deleted_lines, Some(1));
        assert_eq!(
            std::fs::read_to_string(temp.path()).unwrap(),
            "first\nupdated\nthird\n"
        );
    }

    #[test]
    fn edit_file_rejects_ambiguous_text_without_writing() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), "duplicate\nduplicate\n").unwrap();
        let result = execute_edit_file(temp.path().to_str().unwrap(), "duplicate", "updated");
        assert!(result.output.contains("occurs 2 times"));
        assert_eq!(
            std::fs::read_to_string(temp.path()).unwrap(),
            "duplicate\nduplicate\n"
        );
    }

    #[test]
    fn responses_text_uses_output_message_items() {
        let text = output_text(&[
            json!({"type":"reasoning","summary":[]}),
            json!({"type":"message","content":[{"type":"output_text","text":"done"}]}),
        ]);
        assert_eq!(text, "done");
    }

    #[test]
    fn transcription_response_uses_text() {
        assert_eq!(
            transcription_text(&json!({"text":"transcribed"})).unwrap(),
            "transcribed"
        );
        assert!(transcription_text(&json!({})).is_err());
    }

    #[tokio::test]
    async fn agent_uses_responses_endpoint_and_returns_function_outputs() {
        type TestState = (
            Arc<tokio::sync::Mutex<Vec<Value>>>,
            Arc<StdRwLock<SkillCatalog>>,
        );
        let requests = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        let skills = Arc::new(StdRwLock::new(SkillCatalog::default()));
        async fn responses(
            State((requests, skills)): State<TestState>,
            Json(request): Json<Value>,
        ) -> String {
            let mut requests = requests.lock().await;
            let first_request = requests.is_empty();
            let response = if first_request {
                json!({"output":[
                    {"type":"image_generation_call","id":"image_1","status":"completed","result":"aW1hZ2U=","revised_prompt":"A Mobius logo."},
                    {"type":"web_search_call","id":"web_1","status":"completed","action":{"type":"search","query":"Mobius"}},
                    {"type":"function_call","call_id":"call_1","name":"list_files","arguments":"{\"path\":\"/\"}"}
                ]})
            } else {
                json!({"output":[{"type":"message","content":[{"type":"output_text","text":"complete"}]}]})
            };
            let output = response.get("output").and_then(Value::as_array).unwrap();
            requests.push(request);
            if first_request {
                *skills.write().unwrap() = SkillCatalog {
                    skills: vec![SkillMetadata {
                        name: "updated".to_owned(),
                        description: "Reloaded between requests.".to_owned(),
                        directory: "/skills/updated".to_owned(),
                    }],
                };
            }
            let items = output
                .iter()
                .map(|item| {
                    format!(
                        "event: response.output_item.done\ndata: {}\n\n",
                        json!({"type":"response.output_item.done","item":item})
                    )
                })
                .collect::<String>();
            format!(
                "{items}event: response.completed\ndata: {}\n\n",
                json!({"type":"response.completed","response":response})
            )
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_requests = requests.clone();
        let server_skills = skills.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/responses", post(responses))
                    .with_state((server_requests, server_skills)),
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
            filesystem_tools_enabled: true,
            bash_tools_enabled: false,
            web_search_enabled: false,
            image_generation_enabled: false,
            machine_id: "machine".to_owned(),
        };
        let db = tempfile::tempdir().unwrap();
        let db_path = db.path().join("default.sqlite3");
        bootstrap_database(&db_path).unwrap();
        let user = append_conversation(
            &db_path,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("list root".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db_path, "run_1", user.id).unwrap();
        let (events, mut received_events) = mpsc::channel(6);
        let reply = run_agent(
            &reqwest::Client::new(),
            &config,
            vec![ChatMessage {
                role: "user".to_owned(),
                content: Value::String("list root".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            }],
            &db_path,
            &skills,
            AgentEventSink {
                run_id: "run_1",
                sender: &events,
            },
            watch::channel(false).1,
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(reply.message.content, Value::String("complete".to_owned()));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolCall { name, .. }) if name == "image_generation"
        ));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolResult { name, added_lines: None, deleted_lines: None, .. }) if name == "image_generation"
        ));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolCall { name, arguments, .. }) if name == "web_search" && arguments["query"] == "Mobius"
        ));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolResult { name, added_lines: None, deleted_lines: None, .. }) if name == "web_search"
        ));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolCall { name, arguments, .. }) if name == "list_files" && arguments["path"] == "/"
        ));
        assert!(matches!(
            received_events.recv().await,
            Some(AgentEvent::ToolResult { name, added_lines: None, deleted_lines: None, .. }) if name == "list_files"
        ));
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
        let web_search_call = requests[1]
            .get("input")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
            .unwrap();
        assert_eq!(
            web_search_call.get("id").and_then(Value::as_str),
            Some("web_1")
        );
        assert!(web_search_call.get("action").is_none());
        let image_generation_call = requests[1]
            .get("input")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("image_generation_call"))
            .unwrap();
        assert_eq!(
            image_generation_call,
            &json!({"type":"image_generation_call","id":"image_1"})
        );
        assert!(
            requests[1]
                .get("instructions")
                .and_then(Value::as_str)
                .unwrap()
                .contains("/skills/updated")
        );
    }
}
