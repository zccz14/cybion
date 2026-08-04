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
use sha2::{Digest, Sha256};
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
const DEFAULT_SUBTHREAD_MODEL_ID: &str = "gpt-5.6-terra";
const JWKS_TTL: Duration = Duration::from_secs(300);
const CONTEXT_TARGET_CHARS: usize = 96_000;
const CONTEXT_TAIL_MESSAGES: usize = 12;

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    skills_directory: PathBuf,
    skills: Arc<StdRwLock<SkillCatalog>>,
    client: reqwest::Client,
    jwks: Arc<RwLock<Option<CachedJwks>>>,
    resources: Arc<Mutex<resources::ResourceMonitor>>,
    active_runs: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    active_subthreads: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    main_thread: Arc<Mutex<()>>,
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
struct Identity;

#[derive(Debug, Serialize)]
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
    deployment_role: String,
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
    machine_id: String,
    hostname: String,
    deployment_role: String,
    filesystem_enabled: bool,
    bash_enabled: bool,
    created_at: String,
}

#[derive(Deserialize)]
struct CreatePeer {
    name: String,
    base_url: String,
    device_token: String,
}

#[derive(Serialize, Deserialize)]
struct RemoteStatus {
    machine_id: String,
    hostname: String,
    root_user_id: String,
    auth_url: String,
    deployment_role: String,
    filesystem_enabled: bool,
    bash_enabled: bool,
}

#[derive(Deserialize)]
struct RemoteToolRequest {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize, Serialize)]
struct RemoteToolResponse {
    output: String,
    added_lines: Option<usize>,
    deleted_lines: Option<usize>,
}

#[derive(Clone)]
struct DeviceGrant {
    filesystem_enabled: bool,
    bash_enabled: bool,
}

#[derive(Serialize)]
struct DeviceToken {
    id: String,
    label: String,
    filesystem_enabled: bool,
    bash_enabled: bool,
    created_at: String,
}

#[derive(Deserialize)]
struct CreateDeviceToken {
    label: String,
    filesystem_enabled: bool,
    bash_enabled: bool,
}

#[derive(Serialize)]
struct CreatedDeviceToken {
    #[serde(flatten)]
    token: DeviceToken,
    secret: String,
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
    context: ContextState,
}

#[derive(Serialize)]
struct ContextState {
    history_messages: usize,
    checkpoint: Option<ContextCheckpoint>,
}

#[derive(Clone, Serialize)]
struct ContextCheckpoint {
    id: i64,
    through_message_id: i64,
    source_message_count: usize,
    summary: String,
    created_at: String,
}

#[derive(Clone)]
struct HistoryMessage {
    id: i64,
    role: String,
    content: String,
    source_run_id: Option<String>,
}

#[derive(Serialize)]
struct ConversationRun {
    id: String,
    user_message_id: i64,
    status: String,
    events: Vec<AgentEvent>,
}

#[derive(Serialize)]
struct Subthread {
    id: String,
    #[serde(skip)]
    run_id: Option<String>,
    title: String,
    task: String,
    status: String,
    model: String,
    result: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct MainThreadSummary {
    status: String,
    model: String,
    updated_at: Option<String>,
}

#[derive(Serialize)]
struct ThreadIndex {
    main_thread: MainThreadSummary,
    subthreads: Vec<Subthread>,
}

#[derive(Serialize)]
struct SubthreadEvent {
    id: i64,
    event: AgentEvent,
    created_at: String,
}

#[derive(Serialize)]
struct SubthreadDetail {
    thread: Subthread,
    events: Vec<SubthreadEvent>,
}

#[derive(Deserialize)]
struct SubthreadEventQuery {
    #[serde(default)]
    after: i64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum SubthreadStreamMessage {
    Event { item: SubthreadEvent },
    Reaped,
    Error { error: String },
}

struct QueuedSubthread {
    id: String,
    title: String,
    task: String,
    model: String,
    context: Vec<Value>,
    forked_from_message_id: i64,
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
    subthread_model: String,
    openai_base_url: String,
    openai_api_key: String,
    deployment_role: String,
}

#[derive(Deserialize)]
struct UpdateSettings {
    default_model: String,
    subthread_model: String,
    openai_base_url: String,
    openai_api_key: String,
    deployment_role: String,
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

#[derive(Deserialize)]
struct SetupInput {
    auth_url: String,
    openai_api_key: String,
    #[serde(default = "default_openai_url")]
    openai_base_url: String,
    #[serde(default = "default_deployment_role")]
    deployment_role: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AgentEvent {
    Status {
        stage: String,
        message: String,
    },
    Checkpoint {
        id: i64,
        through_message_id: i64,
    },
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum AgentScope {
    Main,
    Subthread,
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
        active_subthreads: Arc::new(Mutex::new(HashMap::new())),
        main_thread: Arc::new(Mutex::new(())),
    };
    schedule_recovered_main_runs(state.clone());
    schedule_subthreads(state.clone());
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

fn schedule_subthreads(state: AppState) {
    tokio::spawn(async move {
        loop {
            match claim_queued_subthreads(&state.db_path) {
                Ok(jobs) => {
                    for job in jobs {
                        let state = state.clone();
                        tokio::spawn(async move {
                            run_subthread(state, job).await;
                        });
                    }
                }
                Err(cause) => tracing::warn!(%cause, "cannot claim queued subthreads"),
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
}

fn schedule_recovered_main_runs(state: AppState) {
    let runs = open_db(&state.db_path).and_then(|connection| {
        connection
            .prepare(
                "SELECT run.id, run.user_message_id,
                        (SELECT event.payload FROM agent_events event
                         WHERE event.run_id = run.id ORDER BY event.id DESC LIMIT 1)
                 FROM agent_runs run
                 WHERE run.kind = 'main' AND run.status = 'running'
                 ORDER BY run.user_message_id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    });
    let Ok(runs) = runs else {
        return;
    };
    for (run_id, user_message_id, latest_event) in runs {
        if !recoverable_main_run(latest_event.as_deref()) {
            let _ = append_agent_event(
                &state.db_path,
                &run_id,
                &AgentEvent::Error {
                    error: "main-thread execution was interrupted by a process restart; it was not replayed because tools may have side effects".to_owned(),
                },
            );
            let _ = finish_agent_run(&state.db_path, &run_id, "failed");
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            let (cancel, cancellation) = watch::channel(false);
            state
                .active_runs
                .lock()
                .await
                .insert(run_id.clone(), cancel);
            let (events, receiver) = mpsc::channel(1);
            drop(receiver);
            process_main_run(state, run_id, user_message_id, events, cancellation).await;
        });
    }
}

fn recoverable_main_run(latest_event: Option<&str>) -> bool {
    latest_event
        .and_then(|payload| serde_json::from_str::<AgentEvent>(payload).ok())
        .is_none_or(|event| {
            matches!(
                event,
                AgentEvent::Status { ref stage, .. } if stage == "queued"
            )
        })
}

fn claim_queued_subthreads(path: &Path) -> Result<Vec<QueuedSubthread>> {
    let mut connection = open_db(path)?;
    let transaction = connection.transaction()?;
    let jobs = transaction
        .prepare(
            "SELECT id, title, task, model, context_json, forked_from_message_id
             FROM subthreads WHERE status = 'queued' ORDER BY created_at",
        )?
        .query_map([], |row| {
            let context: String = row.get(4)?;
            Ok(QueuedSubthread {
                id: row.get(0)?,
                title: row.get(1)?,
                task: row.get(2)?,
                model: row.get(3)?,
                context: serde_json::from_str(&context).unwrap_or_default(),
                forked_from_message_id: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let now = chrono::Utc::now().to_rfc3339();
    for job in &jobs {
        transaction.execute(
            "UPDATE subthreads SET status = 'running', updated_at = ?1
             WHERE id = ?2 AND status = 'queued'",
            params![now, job.id],
        )?;
    }
    transaction.commit()?;
    Ok(jobs)
}

async fn run_subthread(state: AppState, job: QueuedSubthread) {
    let run_id = format!("subthread-{}", job.id);
    let result = create_agent_run_with_kind(
        &state.db_path,
        &run_id,
        job.forked_from_message_id,
        "subthread",
    );
    if let Err(cause) = result {
        let _ = finish_subthread(&state.db_path, &job.id, "failed", Some(&cause.to_string()));
        return;
    }
    let _ = open_db(&state.db_path).and_then(|connection| {
        connection.execute(
            "UPDATE subthreads SET run_id = ?1 WHERE id = ?2",
            params![run_id, job.id],
        )?;
        Ok(())
    });
    let (cancel, cancellation) = watch::channel(false);
    state
        .active_subthreads
        .lock()
        .await
        .insert(job.id.clone(), cancel.clone());
    let still_running = open_db(&state.db_path)
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT status = 'running' FROM subthreads WHERE id = ?1",
                    [&job.id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(Into::into)
        })
        .unwrap_or(false);
    if !still_running {
        let _ = cancel.send(true);
    }
    let (events, receiver) = mpsc::channel(1);
    drop(receiver);
    let sink = AgentEventSink {
        run_id: &run_id,
        sender: &events,
    };
    let started_at = Instant::now();
    let result = match load_config(&state.db_path) {
        Ok(mut config) if config.deployment_role == "controller" => {
            config.default_model = job.model.clone();
            let mut items = job.context;
            items.push(json!({ "role": "user", "content": job.task }));
            run_agent_items(
                &state.client,
                &config,
                items,
                &state.db_path,
                &state.skills,
                sink,
                cancellation,
                AgentScope::Subthread,
                &state.active_subthreads,
            )
            .await
        }
        Ok(_) => Err(anyhow!("tool-executor machines cannot run subthreads")),
        Err(cause) => Err(cause),
    };
    let (status, stored_result, message, usage) = match result {
        Ok(result) => {
            let content = result
                .message
                .content
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let message = ChatMessage {
                role: "assistant".to_owned(),
                content: Value::String(format!(
                    "### Background task completed: {}\n\n{}",
                    job.title, content
                )),
                images: result.message.images,
                tool_call_id: None,
                tool_calls: None,
            };
            let usage = AgentUsage {
                duration_ms: started_at.elapsed().as_millis() as u64,
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
            };
            ("completed", Some(content), message, Some(usage))
        }
        Err(cause) => {
            let status = if cause.to_string() == "agent stopped" {
                "cancelled"
            } else {
                "failed"
            };
            let detail = cause.to_string();
            let message = ChatMessage {
                role: "assistant".to_owned(),
                content: Value::String(format!(
                    "### Background task {}: {}\n\n{}",
                    status, job.title, detail
                )),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            };
            (status, Some(detail), message, None)
        }
    };
    let _ = finish_subthread(&state.db_path, &job.id, status, stored_result.as_deref());
    let _ = finish_agent_run(&state.db_path, &run_id, status);
    let _ = append_conversation_for_run(&state.db_path, &message, usage, Some(&run_id));
    state.active_subthreads.lock().await.remove(&job.id);
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/auth-config.js", get(auth_config_script))
        .route("/", get(index))
        .route("/mobius-mark.png", get(mobius_mark))
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
        .route(
            "/api/device-tokens",
            get(list_device_tokens).post(create_device_token),
        )
        .route("/api/device-tokens/{id}", delete(delete_device_token))
        .route("/api/remote/status", get(remote_status))
        .route("/api/remote/tools/execute", post(remote_execute_tool))
        .route("/api/conversation", get(conversation))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/{id}/events", get(stream_subthread_events))
        .route(
            "/api/threads/{id}",
            get(subthread_detail).delete(cancel_subthread),
        )
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

fn load_history_for_run(path: &Path, user_message_id: i64) -> Result<Vec<HistoryMessage>> {
    let connection = open_db(path)?;
    let mut history = connection
        .prepare(
            "SELECT id, role, content, source_run_id FROM conversation_messages
             WHERE id <= ?1 OR role = 'assistant'
             ORDER BY id",
        )?
        .query_map([user_message_id], |row| {
            Ok(HistoryMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                source_run_id: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for message in &mut history {
        let Some(run_id) = message.source_run_id.as_deref() else {
            continue;
        };
        let trace = connection
            .prepare("SELECT payload FROM agent_events WHERE run_id = ?1 ORDER BY id")?
            .query_map([run_id], |row| row.get::<_, String>(0))?
            .filter_map(std::result::Result::ok)
            .filter_map(|payload| serde_json::from_str::<AgentEvent>(&payload).ok())
            .filter_map(|event| match event {
                AgentEvent::ToolCall {
                    name, arguments, ..
                } => Some(format!("Tool call {name}: {arguments}")),
                AgentEvent::ToolResult {
                    name,
                    output: Some(output),
                    ..
                } => Some(format!("Tool result {name}: {output}")),
                _ => None,
            })
            .collect::<Vec<_>>();
        if !trace.is_empty() {
            message.content = format!(
                "[Durable execution trace]\n{}\n[/Durable execution trace]\n\n{}",
                trace.join("\n"),
                message.content
            );
        }
    }
    Ok(history)
}

fn load_latest_checkpoint(
    connection: &Connection,
    through_message_id: i64,
) -> Result<Option<ContextCheckpoint>> {
    connection
        .query_row(
            "SELECT id, through_message_id, source_message_count, summary, created_at
             FROM context_checkpoints
             WHERE through_message_id <= ?1
             ORDER BY through_message_id DESC, id DESC LIMIT 1",
            [through_message_id],
            |row| {
                Ok(ContextCheckpoint {
                    id: row.get(0)?,
                    through_message_id: row.get(1)?,
                    source_message_count: row.get(2)?,
                    summary: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn context_items(checkpoint: Option<&ContextCheckpoint>, history: &[HistoryMessage]) -> Vec<Value> {
    let mut items = checkpoint
        .map(|checkpoint| {
            vec![json!({
                "role": "developer",
                "content": format!(
                    "Mobius context checkpoint #{} through history message {}. Treat this as a faithful compressed prefix of the complete, auditable main-thread history.\n\n{}",
                    checkpoint.id, checkpoint.through_message_id, checkpoint.summary
                )
            })]
        })
        .unwrap_or_default();
    let through = checkpoint.map(|checkpoint| checkpoint.through_message_id);
    items.extend(
        history
            .iter()
            .filter(|message| through.is_none_or(|id| message.id > id))
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    items
}

fn context_character_count(items: &[Value]) -> usize {
    items
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_str))
        .map(str::len)
        .sum()
}

fn checkpoint_cutoff(
    history: &[HistoryMessage],
    checkpoint: Option<&ContextCheckpoint>,
) -> Option<usize> {
    if history.len() <= CONTEXT_TAIL_MESSAGES {
        return None;
    }
    let cutoff = history.len() - CONTEXT_TAIL_MESSAGES;
    let previous = checkpoint.map(|checkpoint| checkpoint.through_message_id);
    let new_messages = history[..cutoff]
        .iter()
        .filter(|message| previous.is_none_or(|id| message.id > id))
        .count();
    (new_messages >= 4).then_some(cutoff)
}

async fn summarize_context(
    client: &reqwest::Client,
    config: &Config,
    items: Vec<Value>,
    mut cancellation: watch::Receiver<bool>,
) -> Result<String> {
    let request = client
        .post(format!("{}/responses", config.openai_base_url))
        .bearer_auth(&config.openai_api_key)
        .json(&json!({
            "model": config.default_model,
            "input": items,
            "store": false,
            "stream": true,
            "instructions": "Compress this main-thread history prefix into a faithful durable checkpoint. Preserve user goals, decisions, constraints, unfinished work, evidence, file and machine facts, errors, and exact identifiers needed later. Distinguish completed facts from plans. Do not answer the user or invent facts; output only the checkpoint text.",
        }));
    let response = tokio::select! {
        response = request.send() => response?,
        _ = cancellation.changed() => return Err(anyhow!("agent stopped")),
    }
    .error_for_status()?;
    let body = tokio::select! {
        body = response.text() => body?,
        _ = cancellation.changed() => return Err(anyhow!("agent stopped")),
    };
    let summary = output_text(
        completed_response_from_sse(&body)?
            .get("output")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("checkpoint response has no output"))?,
    );
    if summary.trim().is_empty() {
        return Err(anyhow!("checkpoint response has no summary"));
    }
    Ok(summary)
}

async fn compile_main_context(
    client: &reqwest::Client,
    config: &Config,
    db_path: &Path,
    user_message_id: i64,
    events: &AgentEventSink<'_>,
    cancellation: watch::Receiver<bool>,
) -> Result<Vec<Value>> {
    let history = load_history_for_run(db_path, user_message_id)?;
    let checkpoint = {
        let connection = open_db(db_path)?;
        load_latest_checkpoint(&connection, i64::MAX)?
    };
    let current_items = context_items(checkpoint.as_ref(), &history);
    if context_character_count(&current_items) <= CONTEXT_TARGET_CHARS {
        return Ok(current_items);
    }
    let Some(cutoff) = checkpoint_cutoff(&history, checkpoint.as_ref()) else {
        return Ok(current_items);
    };
    let through_message_id = history[cutoff - 1].id;
    let mut source = checkpoint
        .as_ref()
        .map(|checkpoint| {
            vec![json!({
                "role": "developer",
                "content": format!("Previous checkpoint:\n{}", checkpoint.summary)
            })]
        })
        .unwrap_or_default();
    let previous_through = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.through_message_id);
    source.extend(
        history[..cutoff]
            .iter()
            .filter(|message| previous_through.is_none_or(|id| message.id > id))
            .map(|message| json!({ "role": message.role, "content": message.content })),
    );
    send_agent_event(
        db_path,
        events,
        AgentEvent::Status {
            stage: "checkpointing".to_owned(),
            message: "Compressing the stable history prefix".to_owned(),
        },
    )
    .await?;
    // RECOVERY: Checkpointing is an optimization performed before the current context reaches
    // the model limit. If that auxiliary request fails, the complete persisted history remains
    // a valid context for this turn and checkpointing can be retried on the next input.
    let summary = match summarize_context(client, config, source, cancellation).await {
        Ok(summary) => summary,
        Err(cause) if cause.to_string() == "agent stopped" => return Err(cause),
        Err(cause) => {
            send_agent_event(
                db_path,
                events,
                AgentEvent::Status {
                    stage: "running".to_owned(),
                    message: format!("Checkpoint deferred; using the complete history: {cause}"),
                },
            )
            .await?;
            return Ok(current_items);
        }
    };
    let created_at = chrono::Utc::now().to_rfc3339();
    let connection = open_db(db_path)?;
    connection.execute(
        "INSERT INTO context_checkpoints (
           through_message_id, source_message_count, summary, created_at
         ) VALUES (?1, ?2, ?3, ?4)",
        params![through_message_id, cutoff, summary, created_at],
    )?;
    let checkpoint = ContextCheckpoint {
        id: connection.last_insert_rowid(),
        through_message_id,
        source_message_count: cutoff,
        summary,
        created_at,
    };
    send_agent_event(
        db_path,
        events,
        AgentEvent::Checkpoint {
            id: checkpoint.id,
            through_message_id,
        },
    )
    .await?;
    Ok(context_items(Some(&checkpoint), &history))
}

fn append_conversation(
    path: &Path,
    message: &ChatMessage,
    usage: Option<AgentUsage>,
) -> Result<ConversationMessage> {
    append_conversation_for_run(path, message, usage, None)
}

fn append_conversation_for_run(
    path: &Path,
    message: &ChatMessage,
    usage: Option<AgentUsage>,
    source_run_id: Option<&str>,
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
        "INSERT INTO conversation_messages (role, content, created_at, duration_ms, input_tokens, output_tokens, images, source_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            message.role,
            content,
            created_at,
            usage.map(|value| value.duration_ms),
            usage.map(|value| value.input_tokens),
            usage.map(|value| value.output_tokens),
            images,
            source_run_id,
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
    create_agent_run_with_kind(path, id, user_message_id, "main")
}

fn create_agent_run_with_kind(
    path: &Path,
    id: &str,
    user_message_id: i64,
    kind: &str,
) -> Result<()> {
    open_db(path)?.execute(
        "INSERT INTO agent_runs (id, user_message_id, status, created_at, kind)
         VALUES (?1, ?2, 'running', ?3, ?4)",
        params![id, user_message_id, chrono::Utc::now().to_rfc3339(), kind],
    )?;
    Ok(())
}

fn append_agent_event(path: &Path, run_id: &str, event: &AgentEvent) -> Result<()> {
    let event_type = match event {
        AgentEvent::Status { .. } => "status",
        AgentEvent::Checkpoint { .. } => "checkpoint",
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
        .prepare(
            "SELECT id, user_message_id, status FROM agent_runs
             WHERE kind = 'main' ORDER BY created_at, id",
        )?
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
    let checkpoint = load_latest_checkpoint(&connection, i64::MAX)?;
    Ok(ConversationState {
        context: ContextState {
            history_messages: messages.len(),
            checkpoint,
        },
        messages,
        runs,
    })
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
        ("source_run_id", "TEXT"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute_batch(&format!(
                "ALTER TABLE conversation_messages ADD COLUMN {name} {definition}"
            ))?;
        }
    }
    Ok(())
}

fn ensure_agent_run_columns(connection: &Connection) -> Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(agent_runs)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "kind") {
        connection
            .execute_batch("ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'main'")?;
    }
    Ok(())
}

fn ensure_subthread_columns(connection: &Connection) -> Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(subthreads)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if !columns.iter().any(|column| column == "model") {
        connection.execute_batch(&format!(
            "ALTER TABLE subthreads ADD COLUMN model TEXT NOT NULL DEFAULT '{DEFAULT_SUBTHREAD_MODEL_ID}'"
        ))?;
    }
    if columns.iter().any(|column| column == "target_machine_id") {
        connection.execute_batch("ALTER TABLE subthreads DROP COLUMN target_machine_id")?;
    }
    Ok(())
}

fn ensure_agent_event_schema(connection: &Connection) -> Result<()> {
    let schema = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_events'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if schema
        .as_deref()
        .is_some_and(|sql| sql.contains("'status'"))
    {
        return Ok(());
    }
    connection.execute_batch(
        "ALTER TABLE agent_events RENAME TO agent_events_legacy;
         CREATE TABLE agent_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
           event_type TEXT NOT NULL CHECK(event_type IN ('status', 'checkpoint', 'tool_call', 'tool_result', 'context', 'complete', 'error')),
           payload TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         INSERT INTO agent_events (id, run_id, event_type, payload, created_at)
           SELECT id, run_id, event_type, payload, created_at FROM agent_events_legacy;
         DROP TABLE agent_events_legacy;
         CREATE INDEX agent_events_run_id ON agent_events(run_id);",
    )?;
    Ok(())
}

fn ensure_peer_columns(connection: &Connection) -> Result<()> {
    let columns = connection
        .prepare("PRAGMA table_info(peers)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, definition) in [
        ("device_token", "TEXT NOT NULL DEFAULT ''"),
        ("machine_id", "TEXT NOT NULL DEFAULT ''"),
        ("hostname", "TEXT NOT NULL DEFAULT ''"),
        ("deployment_role", "TEXT NOT NULL DEFAULT 'controller'"),
        ("filesystem_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("bash_enabled", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute_batch(&format!("ALTER TABLE peers ADD COLUMN {name} {definition}"))?;
        }
    }
    Ok(())
}

fn bootstrap_database(db: &Path) -> Result<()> {
    let parent = db.parent().context("database path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let connection = open_db(db)?;
    connection.execute_batch(
        "DROP TABLE IF EXISTS work_item_dependencies;
         DROP TABLE IF EXISTS work_items;",
    )?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS peers (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           base_url TEXT NOT NULL UNIQUE,
           device_token TEXT NOT NULL DEFAULT '',
           machine_id TEXT NOT NULL DEFAULT '',
           hostname TEXT NOT NULL DEFAULT '',
           deployment_role TEXT NOT NULL DEFAULT 'controller',
           filesystem_enabled INTEGER NOT NULL DEFAULT 0,
           bash_enabled INTEGER NOT NULL DEFAULT 0,
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
           images TEXT,
           source_run_id TEXT
         );
         CREATE TABLE IF NOT EXISTS agent_runs (
           id TEXT PRIMARY KEY,
           user_message_id INTEGER NOT NULL REFERENCES conversation_messages(id),
           status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
           created_at TEXT NOT NULL,
           completed_at TEXT,
           kind TEXT NOT NULL DEFAULT 'main'
         );
         CREATE TABLE IF NOT EXISTS agent_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
           event_type TEXT NOT NULL CHECK(event_type IN ('status', 'checkpoint', 'tool_call', 'tool_result', 'context', 'complete', 'error')),
           payload TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS agent_events_run_id ON agent_events(run_id);
         CREATE TABLE IF NOT EXISTS context_checkpoints (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           through_message_id INTEGER NOT NULL REFERENCES conversation_messages(id),
           source_message_count INTEGER NOT NULL,
           summary TEXT NOT NULL,
           created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS context_checkpoints_through_message_id
           ON context_checkpoints(through_message_id DESC);
         CREATE TABLE IF NOT EXISTS subthreads (
           id TEXT PRIMARY KEY,
           run_id TEXT UNIQUE,
           title TEXT NOT NULL,
           task TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
           model TEXT NOT NULL,
           context_json TEXT NOT NULL,
           forked_from_message_id INTEGER NOT NULL REFERENCES conversation_messages(id),
           result TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS subthreads_status ON subthreads(status, created_at);
         CREATE TABLE IF NOT EXISTS device_tokens (
           id TEXT PRIMARY KEY,
           label TEXT NOT NULL,
           token_hash TEXT NOT NULL UNIQUE,
           filesystem_enabled INTEGER NOT NULL,
           bash_enabled INTEGER NOT NULL,
           created_at TEXT NOT NULL
         );",
    )?;
    ensure_conversation_metadata_columns(&connection)?;
    ensure_agent_run_columns(&connection)?;
    ensure_agent_event_schema(&connection)?;
    ensure_subthread_columns(&connection)?;
    ensure_peer_columns(&connection)?;
    connection.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS peers_machine_id
         ON peers(machine_id) WHERE machine_id <> '';
         DELETE FROM agent_runs WHERE kind = 'subthread' AND status = 'running';",
    )?;
    connection.execute(
        "UPDATE subthreads SET status = 'queued', run_id = NULL, updated_at = ?1
         WHERE status = 'running'",
        [chrono::Utc::now().to_rfc3339()],
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
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('subthread_model', ?1)
         ON CONFLICT(key) DO NOTHING",
        [DEFAULT_SUBTHREAD_MODEL_ID],
    )?;
    connection.execute(
        "INSERT INTO app_meta (key, value) VALUES ('deployment_role', 'controller')
         ON CONFLICT(key) DO NOTHING",
        [],
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

fn default_deployment_role() -> String {
    "controller".to_owned()
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
    deployment_role: String,
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
        deployment_role: required("deployment_role")?,
    })
}

fn load_subthread_model(path: &Path) -> Result<String> {
    open_db(path)?
        .query_row(
            "SELECT value FROM app_meta WHERE key = 'subthread_model'",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
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
    Ok(Identity)
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn device_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> std::result::Result<DeviceGrant, (StatusCode, Json<ApiError>)> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "missing device bearer token"))?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    connection
        .query_row(
            "SELECT filesystem_enabled, bash_enabled FROM device_tokens WHERE token_hash = ?1",
            [token_hash(token)],
            |row| {
                Ok(DeviceGrant {
                    filesystem_enabled: row.get(0)?,
                    bash_enabled: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot validate device token",
            )
        })?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "invalid device token"))
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
    if !matches!(input.deployment_role.as_str(), "controller" | "executor") {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "deployment_role must be controller or executor",
        ));
    }
    if input.deployment_role == "controller" {
        Url::parse(&input.openai_base_url).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "openai_base_url must be an absolute URL",
            )
        })?;
    }
    if input.deployment_role == "controller" && input.openai_api_key.trim().is_empty() {
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
        ("deployment_role", input.deployment_role.as_str()),
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
        deployment_role: config.deployment_role,
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
async fn mobius_mark() -> Response {
    asset(include_bytes!("../web/dist/mobius-mark.png"), "image/png")
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
        deployment_role: config.deployment_role,
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
        subthread_model: load_subthread_model(&state.db_path).map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read subthread model",
            )
        })?,
        openai_base_url: config.openai_base_url,
        openai_api_key: config.openai_api_key,
        deployment_role: config.deployment_role,
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
    let subthread_model = input.subthread_model.trim();
    if subthread_model.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "subthread_model cannot be empty",
        ));
    }
    let openai_base_url = input.openai_base_url.trim().trim_end_matches('/');
    if !matches!(input.deployment_role.as_str(), "controller" | "executor") {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "deployment_role must be controller or executor",
        ));
    }
    if input.deployment_role == "controller" {
        Url::parse(openai_base_url).map_err(|_| {
            error(
                StatusCode::BAD_REQUEST,
                "openai_base_url must be an absolute URL",
            )
        })?;
    }
    let openai_api_key = input.openai_api_key.trim();
    if input.deployment_role == "controller" && openai_api_key.is_empty() {
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
            "INSERT INTO app_meta (key, value) VALUES ('subthread_model', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [subthread_model],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot save settings"))?;
    transaction
        .execute(
            "INSERT INTO app_meta (key, value) VALUES ('deployment_role', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&input.deployment_role],
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
        subthread_model: subthread_model.to_owned(),
        openai_base_url: openai_base_url.to_owned(),
        openai_api_key: openai_api_key.to_owned(),
        deployment_role: input.deployment_role,
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
        .prepare(
            "SELECT id, name, base_url, machine_id, hostname, deployment_role,
                    filesystem_enabled, bash_enabled, created_at
             FROM peers ORDER BY name",
        )
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
                machine_id: row.get(3)?,
                hostname: row.get(4)?,
                deployment_role: row.get(5)?,
                filesystem_enabled: row.get(6)?,
                bash_enabled: row.get(7)?,
                created_at: row.get(8)?,
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
    let base_url = input.base_url.trim_end_matches('/');
    let remote_url = Url::parse(base_url).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "peer base_url must be an absolute URL",
        )
    })?;
    let loopback = matches!(
        remote_url.host_str(),
        Some("localhost" | "127.0.0.1" | "::1")
    );
    if remote_url.scheme() != "https" && !loopback {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "remote Mobius URLs must use HTTPS except on loopback",
        ));
    }
    if input.device_token.trim().is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "device_token cannot be empty",
        ));
    }
    let remote = state
        .client
        .get(format!("{base_url}/api/remote/status"))
        .bearer_auth(input.device_token.trim())
        .send()
        .await
        .map_err(|cause| {
            error(
                StatusCode::BAD_GATEWAY,
                format!("remote machine is unreachable: {cause}"),
            )
        })?
        .error_for_status()
        .map_err(|cause| {
            error(
                StatusCode::BAD_GATEWAY,
                format!("remote machine rejected its device token: {cause}"),
            )
        })?
        .json::<RemoteStatus>()
        .await
        .map_err(|_| {
            error(
                StatusCode::BAD_GATEWAY,
                "remote machine returned invalid status",
            )
        })?;
    let local = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    if remote.auth_url != local.auth_url || remote.root_user_id != local.root_user_id {
        return Err(error(
            StatusCode::FORBIDDEN,
            "remote machine must use the same Auth Mini issuer and root user",
        ));
    }
    if remote.machine_id == local.machine_id {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "cannot enroll this Mobius machine as its own remote executor",
        ));
    }
    let peer = Peer {
        id: Uuid::new_v4().to_string(),
        name: input.name.trim().to_owned(),
        base_url: base_url.to_owned(),
        machine_id: remote.machine_id,
        hostname: remote.hostname,
        deployment_role: remote.deployment_role,
        filesystem_enabled: remote.filesystem_enabled,
        bash_enabled: remote.bash_enabled,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    if peer.name.is_empty() {
        return Err(error(StatusCode::BAD_REQUEST, "peer name cannot be empty"));
    }
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    connection
        .execute(
            "INSERT INTO peers (
               id, name, base_url, device_token, machine_id, hostname, deployment_role,
               filesystem_enabled, bash_enabled, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                peer.id,
                peer.name,
                peer.base_url,
                input.device_token.trim(),
                peer.machine_id,
                peer.hostname,
                peer.deployment_role,
                peer.filesystem_enabled,
                peer.bash_enabled,
                peer.created_at,
            ],
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
    identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let peer: Option<(String, String)> = connection
        .query_row(
            "SELECT base_url, device_token FROM peers WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read peer"))?;
    let (base_url, device_token) =
        peer.ok_or_else(|| error(StatusCode::NOT_FOUND, "peer does not exist"))?;
    if device_token.is_empty() {
        return Err(error(
            StatusCode::CONFLICT,
            "peer must be re-enrolled with a device token",
        ));
    }
    let response = state
        .client
        .get(format!("{base_url}/api/remote/status"))
        .bearer_auth(device_token)
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
        .json::<RemoteStatus>()
        .await
        .map_err(|_| error(StatusCode::BAD_GATEWAY, "peer returned invalid JSON"))?;
    let local = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    if response.auth_url != local.auth_url || response.root_user_id != local.root_user_id {
        return Err(error(
            StatusCode::FORBIDDEN,
            "remote machine no longer shares this controller's issuer and root user",
        ));
    }
    connection
        .execute(
            "UPDATE peers SET hostname = ?1, deployment_role = ?2,
                              filesystem_enabled = ?3, bash_enabled = ?4
             WHERE id = ?5",
            params![
                response.hostname,
                response.deployment_role,
                response.filesystem_enabled,
                response.bash_enabled,
                id,
            ],
        )
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot refresh peer"))?;
    Ok(Json(
        serde_json::to_value(response).expect("remote status is serializable"),
    ))
}

async fn list_device_tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Vec<DeviceToken>> {
    identity(&state, &headers).await?;
    let connection = open_db(&state.db_path)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot open database"))?;
    let tokens = connection
        .prepare(
            "SELECT id, label, filesystem_enabled, bash_enabled, created_at
             FROM device_tokens ORDER BY created_at DESC",
        )
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read device tokens",
            )
        })?
        .query_map([], |row| {
            Ok(DeviceToken {
                id: row.get(0)?,
                label: row.get(1)?,
                filesystem_enabled: row.get(2)?,
                bash_enabled: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot read device tokens",
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot decode device tokens",
            )
        })?;
    Ok(Json(tokens))
}

async fn create_device_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CreateDeviceToken>,
) -> ApiResult<CreatedDeviceToken> {
    identity(&state, &headers).await?;
    let label = input.label.trim();
    if label.is_empty() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "token label cannot be empty",
        ));
    }
    if !input.filesystem_enabled && !input.bash_enabled {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "a device token must grant at least one tool capability",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let secret = format!(
        "mobius_{}_{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let token = DeviceToken {
        id: id.clone(),
        label: label.to_owned(),
        filesystem_enabled: input.filesystem_enabled,
        bash_enabled: input.bash_enabled,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    open_db(&state.db_path)
        .and_then(|connection| {
            connection.execute(
                "INSERT INTO device_tokens (
                   id, label, token_hash, filesystem_enabled, bash_enabled, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    token.id,
                    token.label,
                    token_hash(&secret),
                    token.filesystem_enabled,
                    token.bash_enabled,
                    token.created_at,
                ],
            )?;
            Ok(())
        })
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot create device token",
            )
        })?;
    Ok(Json(CreatedDeviceToken { token, secret }))
}

async fn delete_device_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    identity(&state, &headers).await?;
    let deleted = open_db(&state.db_path)
        .and_then(|connection| {
            connection
                .execute("DELETE FROM device_tokens WHERE id = ?1", [id])
                .map_err(Into::into)
        })
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot revoke device token",
            )
        })?;
    if deleted == 0 {
        return Err(error(StatusCode::NOT_FOUND, "device token does not exist"));
    }
    Ok(Json(json!({ "deleted": true })))
}

async fn remote_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<RemoteStatus> {
    let grant = device_identity(&state, &headers)?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    Ok(Json(RemoteStatus {
        machine_id: config.machine_id,
        hostname: hostname(),
        root_user_id: config.root_user_id,
        auth_url: config.auth_url,
        deployment_role: config.deployment_role,
        filesystem_enabled: grant.filesystem_enabled && config.filesystem_tools_enabled,
        bash_enabled: grant.bash_enabled && config.bash_tools_enabled,
    }))
}

async fn remote_execute_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<RemoteToolRequest>,
) -> ApiResult<RemoteToolResponse> {
    let grant = device_identity(&state, &headers)?;
    let config = load_config(&state.db_path).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read configuration",
        )
    })?;
    let filesystem_allowed = grant.filesystem_enabled && config.filesystem_tools_enabled;
    let bash_allowed = grant.bash_enabled && config.bash_tools_enabled;
    let execution = match input.name.as_str() {
        "list_files" | "read_file" | "write_file" | "edit_file" if filesystem_allowed => {
            execute_local_tool(&input.name, input.arguments, watch::channel(false).1).await
        }
        "run_bash" if bash_allowed => {
            execute_local_tool(&input.name, input.arguments, watch::channel(false).1).await
        }
        "list_files" | "read_file" | "write_file" | "edit_file" | "run_bash" => {
            return Err(error(
                StatusCode::FORBIDDEN,
                "device token does not grant this tool capability",
            ));
        }
        _ => return Err(error(StatusCode::BAD_REQUEST, "unsupported remote tool")),
    };
    Ok(Json(RemoteToolResponse {
        output: execution.output,
        added_lines: execution.added_lines,
        deleted_lines: execution.deleted_lines,
    }))
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

fn subthread_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Subthread> {
    Ok(Subthread {
        id: row.get(0)?,
        run_id: row.get(1)?,
        title: row.get(2)?,
        task: row.get(3)?,
        status: row.get(4)?,
        model: row.get(5)?,
        result: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn load_subthreads(path: &Path) -> Result<Vec<Subthread>> {
    open_db(path)?
        .prepare(
            "SELECT id, run_id, title, task, status, model, result, created_at, updated_at
             FROM subthreads
             WHERE status IN ('queued', 'running')
             ORDER BY created_at DESC",
        )?
        .query_map([], subthread_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn load_thread_index(path: &Path) -> Result<ThreadIndex> {
    let connection = open_db(path)?;
    let model = connection.query_row(
        "SELECT value FROM app_meta WHERE key = 'default_model'",
        [],
        |row| row.get(0),
    )?;
    let updated_at = connection.query_row(
        "SELECT MAX(created_at) FROM conversation_messages",
        [],
        |row| row.get(0),
    )?;
    let running = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM agent_runs WHERE kind = 'main' AND status = 'running'
         )",
        [],
        |row| row.get::<_, bool>(0),
    )?;
    drop(connection);
    Ok(ThreadIndex {
        main_thread: MainThreadSummary {
            status: if running { "running" } else { "idle" }.to_owned(),
            model,
            updated_at,
        },
        subthreads: load_subthreads(path)?,
    })
}

fn load_subthread_detail(path: &Path, id: &str) -> Result<Option<SubthreadDetail>> {
    let connection = open_db(path)?;
    let thread = connection
        .query_row(
            "SELECT id, run_id, title, task, status, model, result, created_at, updated_at
             FROM subthreads
             WHERE id = ?1 AND status IN ('queued', 'running')",
            [id],
            subthread_from_row,
        )
        .optional()?;
    let Some(thread) = thread else {
        return Ok(None);
    };
    let events = match &thread.run_id {
        Some(run_id) => connection
            .prepare(
                "SELECT id, payload, created_at FROM agent_events
                 WHERE run_id = ?1 ORDER BY id",
            )?
            .query_map([run_id], |row| {
                let payload = row.get::<_, String>(1)?;
                Ok((row.get::<_, i64>(0)?, payload, row.get::<_, String>(2)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(id, payload, created_at)| {
                Ok(SubthreadEvent {
                    id,
                    event: serde_json::from_str(&payload)?,
                    created_at,
                })
            })
            .collect::<Result<Vec<_>>>()?,
        None => Vec::new(),
    };
    Ok(Some(SubthreadDetail { thread, events }))
}

fn load_subthread_events_after(path: &Path, id: &str, after: i64) -> Result<Vec<SubthreadEvent>> {
    open_db(path)?
        .prepare(
            "SELECT event.id, event.payload, event.created_at
             FROM subthreads thread
             JOIN agent_events event ON event.run_id = thread.run_id
             WHERE thread.id = ?1 AND event.id > ?2
             ORDER BY event.id",
        )?
        .query_map(params![id, after], |row| {
            let payload = row.get::<_, String>(1)?;
            Ok((row.get::<_, i64>(0)?, payload, row.get::<_, String>(2)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .map(|(id, payload, created_at)| {
            Ok(SubthreadEvent {
                id,
                event: serde_json::from_str(&payload)?,
                created_at,
            })
        })
        .collect()
}

fn subthread_is_active(path: &Path, id: &str) -> Result<bool> {
    open_db(path)?
        .query_row(
            "SELECT status IN ('queued', 'running') FROM subthreads WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map(|active| active.unwrap_or(false))
        .map_err(Into::into)
}

fn finish_subthread(path: &Path, id: &str, status: &str, result: Option<&str>) -> Result<()> {
    open_db(path)?.execute(
        "UPDATE subthreads SET status = ?1, result = ?2, updated_at = ?3 WHERE id = ?4",
        params![status, result, chrono::Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

fn mark_subthread_cancelled(path: &Path, id: &str) -> Result<()> {
    let changed = open_db(path)?.execute(
        "UPDATE subthreads SET status = 'cancelled', updated_at = ?1
         WHERE id = ?2 AND status IN ('queued', 'running')",
        params![chrono::Utc::now().to_rfc3339(), id],
    )?;
    if changed == 0 {
        return Err(anyhow!("subthread is not active"));
    }
    Ok(())
}

fn execute_fork_subthread(
    path: &Path,
    parent_run_id: &str,
    current_context: &[Value],
    args: Value,
) -> ToolExecution {
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let task = args
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if title.is_empty() || task.is_empty() {
        return tool_execution("error: title and task are required");
    }
    let connection = match open_db(path) {
        Ok(connection) => connection,
        Err(cause) => return tool_execution(format!("error: {cause}")),
    };
    let forked_from_message_id = match connection
        .query_row(
            "SELECT user_message_id FROM agent_runs WHERE id = ?1 AND kind = 'main'",
            [parent_run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
    {
        Ok(Some(id)) => id,
        Ok(None) => return tool_execution("error: subthreads can only fork from the main thread"),
        Err(cause) => return tool_execution(format!("error: {cause}")),
    };
    let model = match connection.query_row(
        "SELECT value FROM app_meta WHERE key = 'subthread_model'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(model) => model,
        Err(cause) => return tool_execution(format!("error: {cause}")),
    };
    let context = current_context
        .iter()
        .filter(|item| item.get("role").is_some())
        .cloned()
        .collect::<Vec<_>>();
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let inserted = connection.execute(
        "INSERT INTO subthreads (
           id, title, task, status, model, context_json,
           forked_from_message_id, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            title,
            task,
            model,
            serde_json::to_string(&context).unwrap_or_else(|_| "[]".to_owned()),
            forked_from_message_id,
            now,
        ],
    );
    match inserted {
        Ok(_) => tool_execution(json!({ "id": id, "status": "queued" }).to_string()),
        Err(cause) => tool_execution(format!("error: {cause}")),
    }
}

async fn list_threads(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<ThreadIndex> {
    identity(&state, &headers).await?;
    load_thread_index(&state.db_path)
        .map(Json)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read threads"))
}

async fn subthread_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<SubthreadDetail> {
    identity(&state, &headers).await?;
    load_subthread_detail(&state.db_path, &id)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read subthread"))?
        .map(Json)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "subthread is no longer active"))
}

async fn stream_subthread_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(cursor): Query<SubthreadEventQuery>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    identity(&state, &headers).await?;
    if !subthread_is_active(&state.db_path, &id)
        .map_err(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "cannot read subthread"))?
    {
        return Err(error(
            StatusCode::NOT_FOUND,
            "subthread is no longer active",
        ));
    }
    let db_path = state.db_path.clone();
    let (sender, receiver) = mpsc::channel(32);
    tokio::spawn(async move {
        let mut after = cursor.after;
        loop {
            match load_subthread_events_after(&db_path, &id, after) {
                Ok(events) => {
                    for item in events {
                        after = item.id;
                        if sender
                            .send(SubthreadStreamMessage::Event { item })
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                Err(cause) => {
                    let _ = sender
                        .send(SubthreadStreamMessage::Error {
                            error: cause.to_string(),
                        })
                        .await;
                    return;
                }
            }
            match subthread_is_active(&db_path, &id) {
                Ok(true) => tokio::time::sleep(Duration::from_millis(250)).await,
                Ok(false) => {
                    let _ = sender.send(SubthreadStreamMessage::Reaped).await;
                    return;
                }
                Err(cause) => {
                    let _ = sender
                        .send(SubthreadStreamMessage::Error {
                            error: cause.to_string(),
                        })
                        .await;
                    return;
                }
            }
        }
    });
    let stream = ReceiverStream::new(receiver).map(|message| {
        Ok::<_, Infallible>(Event::default().data(serde_json::to_string(&message).unwrap()))
    });
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

async fn cancel_subthread(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Value> {
    identity(&state, &headers).await?;
    if let Some(cancel) = state.active_subthreads.lock().await.get(&id) {
        let _ = cancel.send(true);
    }
    mark_subthread_cancelled(&state.db_path, &id)
        .map_err(|cause| error(StatusCode::CONFLICT, cause.to_string()))?;
    Ok(Json(json!({ "cancelled": true })))
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
    if config.deployment_role != "controller" {
        return Err(error(
            StatusCode::CONFLICT,
            "tool-executor machines do not have an audio transcription upstream",
        ));
    }
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
    if config.deployment_role != "controller" {
        return Err(error(
            StatusCode::CONFLICT,
            "this Mobius machine is configured as a tool executor and has no model upstream",
        ));
    }
    let user_message = append_conversation(&state.db_path, &input.message, None).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot save conversation message",
        )
    })?;
    create_agent_run(&state.db_path, &input.run_id, user_message.id)
        .map_err(|_| error(StatusCode::CONFLICT, "agent run already exists"))?;
    let run_id = input.run_id.clone();
    let (cancel, cancellation) = watch::channel(false);
    state
        .active_runs
        .lock()
        .await
        .insert(run_id.clone(), cancel);
    let (events, receiver) = mpsc::channel(32);
    tokio::spawn(process_main_run(
        state.clone(),
        run_id,
        user_message.id,
        events,
        cancellation,
    ));
    let stream = ReceiverStream::new(receiver).map(|event| {
        Ok::<_, Infallible>(Event::default().data(serde_json::to_string(&event).unwrap()))
    });
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

fn is_next_main_run(path: &Path, user_message_id: i64) -> Result<bool> {
    open_db(path)?
        .query_row(
            "SELECT NOT EXISTS(
               SELECT 1 FROM agent_runs
               WHERE kind = 'main' AND status = 'running' AND user_message_id < ?1
             )",
            [user_message_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

async fn process_main_run(
    state: AppState,
    run_id: String,
    user_message_id: i64,
    events: mpsc::Sender<AgentEvent>,
    cancellation: watch::Receiver<bool>,
) {
    let started_at = Instant::now();
    let sink = AgentEventSink {
        run_id: &run_id,
        sender: &events,
    };
    let _ = send_agent_event(
        &state.db_path,
        &sink,
        AgentEvent::Status {
            stage: "queued".to_owned(),
            message: "Accepted into the main thread".to_owned(),
        },
    )
    .await;
    let mut queued_cancellation = cancellation.clone();
    let guard = loop {
        let candidate = tokio::select! {
            guard = state.main_thread.lock() => Some(guard),
            _ = queued_cancellation.changed() => None,
        };
        let Some(candidate) = candidate else {
            break None;
        };
        if is_next_main_run(&state.db_path, user_message_id).unwrap_or(false) {
            break Some(candidate);
        }
        drop(candidate);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            _ = queued_cancellation.changed() => break None,
        }
    };
    let result = match guard {
        None => Err(anyhow!("agent stopped")),
        Some(_guard) => {
            let _ = send_agent_event(
                &state.db_path,
                &sink,
                AgentEvent::Status {
                    stage: "running".to_owned(),
                    message: "Compiling the main-thread context".to_owned(),
                },
            )
            .await;
            match load_config(&state.db_path) {
                Ok(config) if config.deployment_role == "controller" => match compile_main_context(
                    &state.client,
                    &config,
                    &state.db_path,
                    user_message_id,
                    &sink,
                    cancellation.clone(),
                )
                .await
                {
                    Ok(items) => {
                        run_agent_items(
                            &state.client,
                            &config,
                            items,
                            &state.db_path,
                            &state.skills,
                            sink,
                            cancellation,
                            AgentScope::Main,
                            &state.active_subthreads,
                        )
                        .await
                    }
                    Err(cause) => Err(cause),
                },
                Ok(_) => Err(anyhow!("tool-executor machines cannot run the main thread")),
                Err(cause) => Err(cause),
            }
        }
    };
    let event = match result {
        Ok(result) => {
            let usage = AgentUsage {
                duration_ms: started_at.elapsed().as_millis() as u64,
                input_tokens: result.input_tokens,
                output_tokens: result.output_tokens,
            };
            match append_conversation_for_run(
                &state.db_path,
                &result.message,
                Some(usage),
                Some(&run_id),
            ) {
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
        &state.db_path,
        &AgentEventSink {
            run_id: &run_id,
            sender: &events,
        },
        event,
    )
    .await;
    let _ = finish_agent_run(&state.db_path, &run_id, status);
    state.active_runs.lock().await.remove(&run_id);
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

#[cfg(test)]
async fn run_agent(
    client: &reqwest::Client,
    config: &Config,
    messages: Vec<ChatMessage>,
    db_path: &Path,
    skills: &Arc<StdRwLock<SkillCatalog>>,
    events: AgentEventSink<'_>,
    cancellation: watch::Receiver<bool>,
) -> Result<AgentResult> {
    let items = messages
        .into_iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect::<Vec<_>>();
    run_agent_items(
        client,
        config,
        items,
        db_path,
        skills,
        events,
        cancellation,
        AgentScope::Main,
        &Arc::new(Mutex::new(HashMap::new())),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_items(
    client: &reqwest::Client,
    config: &Config,
    mut items: Vec<Value>,
    db_path: &Path,
    skills: &Arc<StdRwLock<SkillCatalog>>,
    events: AgentEventSink<'_>,
    mut cancellation: watch::Receiver<bool>,
    scope: AgentScope,
    active_subthreads: &Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
) -> Result<AgentResult> {
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut images = Vec::new();
    loop {
        if *cancellation.borrow() {
            return Err(anyhow!("agent stopped"));
        }
        let request = client
            .post(format!("{}/responses", config.openai_base_url))
            .bearer_auth(&config.openai_api_key)
            .json(&scoped_responses_request_body(
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
                scope,
                db_path,
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
        images.extend(generated_images(&output));
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
            let execution = execute_tool(
                name,
                args,
                db_path,
                client,
                config.filesystem_tools_enabled,
                config.bash_tools_enabled,
                &items,
                events.run_id,
                scope,
                active_subthreads,
                cancellation.clone(),
            )
            .await;
            send_agent_event(
                db_path,
                &events,
                AgentEvent::ToolResult {
                    call_id: call_id.to_owned(),
                    name: name.to_owned(),
                    added_lines: execution.added_lines,
                    deleted_lines: execution.deleted_lines,
                    output: Some(execution.output.clone()),
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
                // COMPATIBILITY: This upstream rejects `action` when a web-search result is
                // replayed through `input`. Remove this once replay accepts `action`.
                item.as_object_mut()
                    .expect("a JSON value with type is an object")
                    .remove("action");
                item
            }
            Some("image_generation_call") => {
                // COMPATIBILITY: This upstream rejects generated-image `action` and its
                // native pixel `size` (for example, 1254x1254) during replay. Keep the image
                // result because `store: false` prevents ID-only references from resolving.
                // Remove this once the upstream accepts the full output item; verify with the
                // stateless image-generation continuation test.
                let image = item
                    .as_object_mut()
                    .expect("image generation call is an object");
                image.remove("action");
                image.remove("size");
                item
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

#[allow(clippy::too_many_arguments)]
fn scoped_responses_request_body(
    model: &str,
    input: &[Value],
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    web_search_enabled: bool,
    image_generation_enabled: bool,
    skills: &SkillCatalog,
    scope: AgentScope,
    db_path: &Path,
) -> Value {
    let (remote_filesystem_enabled, remote_bash_enabled) =
        remote_tool_capabilities(db_path).unwrap_or_default();
    let mut body = responses_request_body(
        model,
        input,
        filesystem_tools_enabled || remote_filesystem_enabled,
        bash_tools_enabled || remote_bash_enabled,
        web_search_enabled,
        image_generation_enabled,
        skills,
    );
    let machines = remote_machine_context(db_path).unwrap_or_default();
    if scope == AgentScope::Main {
        let tools = body
            .as_object_mut()
            .expect("responses request body is an object")
            .entry("tools")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("tool definitions are an array");
        tools.extend([
            json!({"type":"function","name":"list_subthreads","description":"Inspect Mobius's internal background execution branches. These are implementation details of the single user-visible main thread, not user-managed sessions.","parameters":{"type":"object","additionalProperties":false,"properties":{}}}),
            json!({"type":"function","name":"fork_subthread","description":"Fork a bounded background task from the compiled main-thread context. The subthread runs on this controller; each filesystem or Bash call may independently select an enrolled device. Return promptly after dispatch because Mobius automatically merges the result into the main conversation.","parameters":{"type":"object","additionalProperties":false,"required":["title","task"],"properties":{"title":{"type":"string"},"task":{"type":"string"}}}}),
            json!({"type":"function","name":"cancel_subthread","description":"Terminate an active internal subthread that is no longer relevant or must be rebuilt.","parameters":{"type":"object","additionalProperties":false,"required":["id"],"properties":{"id":{"type":"string"}}}}),
        ]);
        body["tool_choice"] = Value::String("auto".to_owned());
    }
    let scope_instructions = match scope {
        AgentScope::Main => {
            "You are Mobius's single user-visible main thread. Accept every user input as part of one durable conversation. Give a concise response promptly. Fork only bounded work that can proceed without continuous user judgment; inspect existing subthreads before replacing work, cancel obsolete branches, and let Mobius merge background results automatically. Never ask the user to manage subthreads as sessions."
        }
        AgentScope::Subthread => {
            "You are an internal Mobius subthread forked from a compiled main-thread checkpoint. Complete the bounded task using the inherited context, return a self-contained result with reusable environment facts and evidence, and do not ask the user to manage this branch. The result is merged into the main thread automatically."
        }
    };
    let instructions = body
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or_default();
    body["instructions"] = Value::String(format!("{instructions}\n{scope_instructions}"));
    if !machines.is_empty() {
        let instructions = body
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default();
        body["instructions"] = Value::String(format!(
            "{instructions}\nEnrolled remote execution devices and their minimal capabilities are listed below. Set a filesystem or Bash tool's target_device to one of these exact IDs to execute that single call remotely; omit target_device to execute locally.\n{machines}"
        ));
    }
    body
}

fn remote_tool_capabilities(path: &Path) -> Result<(bool, bool)> {
    open_db(path)?
        .query_row(
            "SELECT COALESCE(MAX(filesystem_enabled), 0), COALESCE(MAX(bash_enabled), 0)
             FROM peers WHERE machine_id <> ''",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(Into::into)
}

fn remote_machine_context(path: &Path) -> Result<String> {
    let connection = open_db(path)?;
    let machines = connection
        .prepare(
            "SELECT machine_id, name, hostname, deployment_role, filesystem_enabled, bash_enabled
             FROM peers WHERE machine_id <> '' ORDER BY name",
        )?
        .query_map([], |row| {
            Ok(json!({
                "target_device": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "hostname": row.get::<_, String>(2)?,
                "deployment_role": row.get::<_, String>(3)?,
                "capabilities": {
                    "filesystem": row.get::<_, bool>(4)?,
                    "bash": row.get::<_, bool>(5)?,
                }
            }))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if machines.is_empty() {
        Ok(String::new())
    } else {
        serde_json::to_string(&machines).map_err(Into::into)
    }
}

fn skill_instructions(skills: &SkillCatalog) -> String {
    let metadata = serde_json::to_string(&skills.skills).expect("skill metadata is serializable");
    format!(
        "Follow Mobius's one more step philosophy: use the current conversation, tool feedback, and observed evidence to choose and complete the next useful step, then reassess. Complete one useful, verifiable step at a time and let each result inform what comes next.\nInstalled SKILL metadata is refreshed before every API request. When you choose a skill, first read its SKILL.md with the read_file tool, then follow it. The directory field is the skill installation directory and can be used to read files referenced by SKILL.md.\n{metadata}"
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
                output: None,
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
    let mut tools = Vec::new();
    if filesystem_tools_enabled {
        tools.extend([
            json!({"type":"function","name":"list_files","description":"List files in any directory. Omit target_device to use the current device, or set it to an enrolled device ID for this call.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"},"target_device":{"type":"string","description":"Optional enrolled device ID. Omit to execute on the current device."}}}}),
            json!({"type":"function","name":"read_file","description":"Read a file from any path. Binary files are returned as base64 JSON. Omit target_device to use the current device, or set it to an enrolled device ID for this call.","parameters":{"type":"object","additionalProperties":false,"required":["path"],"properties":{"path":{"type":"string"},"target_device":{"type":"string","description":"Optional enrolled device ID. Omit to execute on the current device."}}}}),
            json!({"type":"function","name":"write_file","description":"Write a UTF-8 text file to any existing path. Omit target_device to use the current device, or set it to an enrolled device ID for this call.","parameters":{"type":"object","additionalProperties":false,"required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"},"target_device":{"type":"string","description":"Optional enrolled device ID. Omit to execute on the current device."}}}}),
            json!({"type":"function","name":"edit_file","description":"Partially edit a UTF-8 text file by replacing one exact old_text match with new_text. Use this after reading the file; old_text must occur exactly once. Omit target_device to use the current device, or set it to an enrolled device ID for this call.","parameters":{"type":"object","additionalProperties":false,"required":["path","old_text","new_text"],"properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"},"target_device":{"type":"string","description":"Optional enrolled device ID. Omit to execute on the current device."}}}}),
        ]);
    }
    if bash_tools_enabled {
        tools.push(json!({"type":"function","name":"run_bash","description":"Execute a Bash command and return stdout, stderr, and the exit status. Omit target_device to use the current device, or set it to an enrolled device ID for this call.","parameters":{"type":"object","additionalProperties":false,"required":["command"],"properties":{"command":{"type":"string"},"target_device":{"type":"string","description":"Optional enrolled device ID. Omit to execute on the current device."}}}}));
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

#[allow(clippy::too_many_arguments)]
async fn execute_tool(
    name: &str,
    args: Value,
    db_path: &Path,
    client: &reqwest::Client,
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    current_context: &[Value],
    run_id: &str,
    scope: AgentScope,
    active_subthreads: &Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    cancellation: watch::Receiver<bool>,
) -> ToolExecution {
    match name {
        "list_files" | "read_file" | "write_file" | "edit_file" | "run_bash" => {
            execute_device_tool(
                name,
                args,
                db_path,
                client,
                filesystem_tools_enabled,
                bash_tools_enabled,
                cancellation,
            )
            .await
        }
        "list_subthreads" if scope == AgentScope::Main => load_subthreads(db_path)
            .and_then(|threads| serde_json::to_string(&threads).map_err(Into::into))
            .map(tool_execution)
            .unwrap_or_else(|cause| tool_execution(format!("error: {cause}"))),
        "fork_subthread" if scope == AgentScope::Main => {
            execute_fork_subthread(db_path, run_id, current_context, args)
        }
        "cancel_subthread" if scope == AgentScope::Main => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or("");
            if let Some(cancel) = active_subthreads.lock().await.get(id) {
                let _ = cancel.send(true);
            }
            match mark_subthread_cancelled(db_path, id) {
                Ok(()) => tool_execution("cancelled"),
                Err(cause) => tool_execution(format!("error: {cause}")),
            }
        }
        _ => tool_execution("error: unknown tool"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_device_tool(
    name: &str,
    mut args: Value,
    db_path: &Path,
    client: &reqwest::Client,
    filesystem_tools_enabled: bool,
    bash_tools_enabled: bool,
    cancellation: watch::Receiver<bool>,
) -> ToolExecution {
    let target_device = match args.get("target_device") {
        None => None,
        Some(Value::String(target_device)) if !target_device.is_empty() => {
            Some(target_device.to_owned())
        }
        Some(_) => return tool_execution("error: target_device must be a non-empty device ID"),
    };
    if let Some(target_device) = target_device {
        if let Some(arguments) = args.as_object_mut() {
            arguments.remove("target_device");
        }
        return execute_remote_device(client, db_path, &target_device, name, args, cancellation)
            .await;
    }
    let local_enabled = match name {
        "list_files" | "read_file" | "write_file" | "edit_file" => filesystem_tools_enabled,
        "run_bash" => bash_tools_enabled,
        _ => false,
    };
    if !local_enabled {
        return tool_execution("error: this tool is not enabled on the current device");
    }
    execute_local_tool(name, args, cancellation).await
}

async fn execute_local_tool(
    name: &str,
    args: Value,
    cancellation: watch::Receiver<bool>,
) -> ToolExecution {
    let path = args.get("path").and_then(Value::as_str).unwrap_or("");
    match name {
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

async fn execute_remote_device(
    client: &reqwest::Client,
    db_path: &Path,
    target_device: &str,
    tool: &str,
    arguments: Value,
    mut cancellation: watch::Receiver<bool>,
) -> ToolExecution {
    let peer = open_db(db_path).and_then(|connection| {
        connection
            .query_row(
                "SELECT base_url, device_token FROM peers WHERE machine_id = ?1",
                [target_device],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(Into::into)
    });
    let (base_url, device_token) = match peer {
        Ok(Some(peer)) if !peer.1.is_empty() => peer,
        Ok(Some(_)) => return tool_execution("error: remote device has no device token"),
        Ok(None) => return tool_execution("error: unknown target device"),
        Err(cause) => return tool_execution(format!("error: cannot read target device: {cause}")),
    };
    let request = client
        .post(format!("{base_url}/api/remote/tools/execute"))
        .bearer_auth(device_token)
        .json(&json!({ "name": tool, "arguments": arguments }));
    let response = tokio::select! {
        response = request.send() => response,
        _ = cancellation.changed() => return tool_execution("error: agent stopped"),
    };
    let response = match response.and_then(reqwest::Response::error_for_status) {
        Ok(response) => response,
        Err(cause) => return tool_execution(format!("error: remote tool request failed: {cause}")),
    };
    match response.json::<RemoteToolResponse>().await {
        Ok(response) => ToolExecution {
            output: response.output,
            added_lines: response.added_lines,
            deleted_lines: response.deleted_lines,
        },
        Err(cause) => tool_execution(format!("error: invalid remote tool response: {cause}")),
    }
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

    fn configure_test_database(db: &Path, openai_base_url: &str) {
        let connection = open_db(db).unwrap();
        for (key, value) in [
            ("root_user_id", "root"),
            ("auth_url", "https://auth.example.com"),
            ("openai_base_url", openai_base_url),
            ("openai_api_key", "test-key"),
            ("deployment_role", "controller"),
        ] {
            connection
                .execute(
                    "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![key, value],
                )
                .unwrap();
        }
    }

    fn test_state(db_path: PathBuf) -> AppState {
        let skills_directory = db_path.parent().unwrap().join("skills");
        std::fs::create_dir_all(&skills_directory).unwrap();
        AppState {
            resources: Arc::new(Mutex::new(resources::ResourceMonitor::new(db_path.clone()))),
            db_path,
            skills_directory,
            skills: Arc::new(StdRwLock::new(SkillCatalog::default())),
            client: reqwest::Client::new(),
            jwks: Arc::new(RwLock::new(None)),
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            active_subthreads: Arc::new(Mutex::new(HashMap::new())),
            main_thread: Arc::new(Mutex::new(())),
        }
    }

    #[tokio::test]
    async fn favicon_is_served_as_png() {
        let response = mobius_mark().await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    }

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
        let subthread_model: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'subthread_model'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(subthread_model, DEFAULT_SUBTHREAD_MODEL_ID);
        let deployment_role: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'deployment_role'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deployment_role, "controller");
    }

    #[test]
    fn context_checkpoint_is_a_stable_prefix_of_complete_history() {
        let checkpoint = ContextCheckpoint {
            id: 7,
            through_message_id: 2,
            source_message_count: 2,
            summary: "The operator selected Mobius and kept the main thread active.".to_owned(),
            created_at: "2026-08-04T00:00:00Z".to_owned(),
        };
        let mut history = vec![
            HistoryMessage {
                id: 1,
                role: "user".to_owned(),
                content: "Choose a name".to_owned(),
                source_run_id: None,
            },
            HistoryMessage {
                id: 2,
                role: "assistant".to_owned(),
                content: "Mobius".to_owned(),
                source_run_id: None,
            },
            HistoryMessage {
                id: 3,
                role: "user".to_owned(),
                content: "Implement checkpoints".to_owned(),
                source_run_id: None,
            },
        ];
        let first = context_items(Some(&checkpoint), &history);
        history.push(HistoryMessage {
            id: 4,
            role: "assistant".to_owned(),
            content: "Implemented".to_owned(),
            source_run_id: None,
        });
        let second = context_items(Some(&checkpoint), &history);
        assert_eq!(first[0], second[0]);
        assert_eq!(first[0]["role"], "developer");
        assert!(
            first[0]["content"]
                .as_str()
                .unwrap()
                .contains("checkpoint #7")
        );
        assert_eq!(first[1]["content"], "Implement checkpoints");
        assert_eq!(second[2]["content"], "Implemented");
    }

    #[test]
    fn checkpoint_cutoff_keeps_a_recent_uncompressed_tail() {
        let history = (1..=20)
            .map(|id| HistoryMessage {
                id,
                role: if id % 2 == 0 { "assistant" } else { "user" }.to_owned(),
                content: format!("message {id}"),
                source_run_id: None,
            })
            .collect::<Vec<_>>();
        let cutoff = checkpoint_cutoff(&history, None).unwrap();
        assert_eq!(history.len() - cutoff, CONTEXT_TAIL_MESSAGES);
        let checkpoint = ContextCheckpoint {
            id: 1,
            through_message_id: 7,
            source_message_count: 7,
            summary: "prefix".to_owned(),
            created_at: "now".to_owned(),
        };
        assert_eq!(checkpoint_cutoff(&history, Some(&checkpoint)), None);
    }

    #[test]
    fn subthread_fork_persists_compiled_context_and_recovers_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("ship it".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "main-run", user.id).unwrap();
        open_db(&db)
            .unwrap()
            .execute(
                "UPDATE app_meta SET value = 'subthread-test-model' WHERE key = 'subthread_model'",
                [],
            )
            .unwrap();
        let execution = execute_fork_subthread(
            &db,
            "main-run",
            &[
                json!({"role":"developer","content":"checkpoint"}),
                json!({"role":"user","content":"ship it"}),
                json!({"type":"function_call","name":"fork_subthread"}),
            ],
            json!({"title":"Verify","task":"Run the full test suite"}),
        );
        let created: Value = serde_json::from_str(&execution.output).unwrap();
        assert_eq!(created["status"], "queued");
        let jobs = claim_queued_subthreads(&db).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].context.len(), 2);
        assert_eq!(jobs[0].model, "subthread-test-model");
        let running = load_subthreads(&db).unwrap();
        assert_eq!(running[0].status, "running");
        assert_eq!(running[0].model, "subthread-test-model");
        let columns = open_db(&db)
            .unwrap()
            .prepare("PRAGMA table_info(subthreads)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "target_machine_id"));
        bootstrap_database(&db).unwrap();
        assert_eq!(load_subthreads(&db).unwrap()[0].status, "queued");
    }

    #[test]
    fn legacy_subthread_target_machine_column_is_removed() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        open_db(&db)
            .unwrap()
            .execute_batch("ALTER TABLE subthreads ADD COLUMN target_machine_id TEXT")
            .unwrap();

        bootstrap_database(&db).unwrap();
        let columns = open_db(&db)
            .unwrap()
            .prepare("PRAGMA table_info(subthreads)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "target_machine_id"));
    }

    #[test]
    fn subthread_detail_loads_history_and_event_cursor_until_reaped() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("inspect history".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "main-run", user.id).unwrap();
        let fork = execute_fork_subthread(
            &db,
            "main-run",
            &[json!({"role":"user","content":"inspect history"})],
            json!({"title":"History","task":"Inspect persisted events"}),
        );
        let id = serde_json::from_str::<Value>(&fork.output).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let _ = claim_queued_subthreads(&db).unwrap();
        let run_id = format!("subthread-{id}");
        create_agent_run_with_kind(&db, &run_id, user.id, "subthread").unwrap();
        open_db(&db)
            .unwrap()
            .execute(
                "UPDATE subthreads SET run_id = ?1 WHERE id = ?2",
                params![run_id, id],
            )
            .unwrap();
        append_agent_event(
            &db,
            &run_id,
            &AgentEvent::Status {
                stage: "running".to_owned(),
                message: "Inspecting".to_owned(),
            },
        )
        .unwrap();
        append_agent_event(&db, &run_id, &AgentEvent::Context { input_tokens: 42 }).unwrap();
        let detail = load_subthread_detail(&db, &id).unwrap().unwrap();
        assert_eq!(detail.thread.model, DEFAULT_SUBTHREAD_MODEL_ID);
        assert_eq!(detail.events.len(), 2);
        let next = load_subthread_events_after(&db, &id, detail.events[0].id).unwrap();
        assert_eq!(next.len(), 1);
        assert!(matches!(
            next[0].event,
            AgentEvent::Context { input_tokens: 42 }
        ));
        finish_subthread(&db, &id, "completed", Some("reaped")).unwrap();
        assert!(load_subthread_detail(&db, &id).unwrap().is_none());
        assert!(!subthread_is_active(&db, &id).unwrap());
    }

    #[test]
    fn thread_index_keeps_main_thread_first_class_and_models_independent() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        open_db(&db)
            .unwrap()
            .execute_batch(
                "UPDATE app_meta SET value = 'main-index-model' WHERE key = 'default_model';
                 UPDATE app_meta SET value = 'sub-index-model' WHERE key = 'subthread_model';",
            )
            .unwrap();

        let empty = load_thread_index(&db).unwrap();
        assert_eq!(empty.main_thread.status, "idle");
        assert_eq!(empty.main_thread.model, "main-index-model");
        assert!(empty.main_thread.updated_at.is_none());
        assert!(empty.subthreads.is_empty());

        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("index this thread".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "main-index-run", user.id).unwrap();
        let fork = execute_fork_subthread(
            &db,
            "main-index-run",
            &[json!({"role":"user","content":"index this thread"})],
            json!({"title":"Index","task":"Verify the thread index"}),
        );
        assert_eq!(
            serde_json::from_str::<Value>(&fork.output).unwrap()["status"],
            "queued"
        );

        let active = load_thread_index(&db).unwrap();
        assert_eq!(active.main_thread.status, "running");
        assert_eq!(active.main_thread.model, "main-index-model");
        assert_eq!(
            active.main_thread.updated_at.as_deref(),
            Some(user.created_at.as_str())
        );
        assert_eq!(active.subthreads.len(), 1);
        assert_eq!(active.subthreads[0].model, "sub-index-model");

        finish_agent_run(&db, "main-index-run", "completed").unwrap();
        assert_eq!(load_thread_index(&db).unwrap().main_thread.status, "idle");
    }

    #[test]
    fn main_thread_runs_follow_persisted_user_input_order() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let append_user = |content: &str| {
            append_conversation(
                &db,
                &ChatMessage {
                    role: "user".to_owned(),
                    content: Value::String(content.to_owned()),
                    images: None,
                    tool_call_id: None,
                    tool_calls: None,
                },
                None,
            )
            .unwrap()
        };
        let first = append_user("first");
        let second = append_user("second");
        create_agent_run(&db, "run-first", first.id).unwrap();
        create_agent_run(&db, "run-second", second.id).unwrap();
        assert!(is_next_main_run(&db, first.id).unwrap());
        assert!(!is_next_main_run(&db, second.id).unwrap());
        finish_agent_run(&db, "run-first", "completed").unwrap();
        assert!(is_next_main_run(&db, second.id).unwrap());
    }

    #[test]
    fn restart_recovers_only_inputs_that_never_started_tool_execution() {
        let queued = serde_json::to_string(&AgentEvent::Status {
            stage: "queued".to_owned(),
            message: "accepted".to_owned(),
        })
        .unwrap();
        let running = serde_json::to_string(&AgentEvent::Status {
            stage: "running".to_owned(),
            message: "compiling".to_owned(),
        })
        .unwrap();
        let tool = serde_json::to_string(&AgentEvent::ToolCall {
            call_id: "call".to_owned(),
            name: "run_bash".to_owned(),
            arguments: json!({"command":"deploy"}),
        })
        .unwrap();
        assert!(recoverable_main_run(None));
        assert!(recoverable_main_run(Some(&queued)));
        assert!(!recoverable_main_run(Some(&running)));
        assert!(!recoverable_main_run(Some(&tool)));
    }

    #[test]
    fn scoped_agent_tools_keep_subthreads_local_and_expose_remote_devices_per_call() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        open_db(&db)
            .unwrap()
            .execute(
                "INSERT INTO peers (
               id, name, base_url, device_token, machine_id, hostname, deployment_role,
               filesystem_enabled, bash_enabled, created_at
             ) VALUES ('peer', 'Build host', 'https://build.example', 'secret-token',
                       'machine-build', 'build-1', 'executor', 1, 0, 'now')",
                [],
            )
            .unwrap();
        let main = scoped_responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
            AgentScope::Main,
            &db,
        );
        let subthread = scoped_responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
            AgentScope::Subthread,
            &db,
        );
        let names = |body: &Value| {
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert!(names(&main).iter().any(|name| name == "fork_subthread"));
        assert!(
            !names(&subthread)
                .iter()
                .any(|name| name == "fork_subthread")
        );
        assert!(names(&subthread).iter().any(|name| name == "read_file"));
        assert!(!names(&main).iter().any(|name| name == "run_on_machine"));
        let fork = main["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "fork_subthread")
            .unwrap();
        assert!(fork.pointer("/parameters/properties/machine_id").is_none());
        let read_file = subthread["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == "read_file")
            .unwrap();
        assert_eq!(
            read_file.pointer("/parameters/properties/target_device/type"),
            Some(&Value::String("string".to_owned()))
        );
        let instructions = main["instructions"].as_str().unwrap();
        assert!(instructions.contains("machine-build"));
        assert!(instructions.contains("target_device"));
        assert!(!instructions.contains("secret-token"));
    }

    #[test]
    fn filesystem_and_bash_tools_accept_optional_target_device() {
        let tools = tool_definitions(true, true, false, false);
        for name in [
            "list_files",
            "read_file",
            "write_file",
            "edit_file",
            "run_bash",
        ] {
            let tool = tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            assert_eq!(
                tool.pointer("/parameters/properties/target_device/type"),
                Some(&Value::String("string".to_owned()))
            );
            assert!(
                !tool["parameters"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&Value::String("target_device".to_owned()))
            );
        }
    }

    #[tokio::test]
    async fn target_device_routes_only_that_tool_call_to_the_remote_executor() {
        async fn capture_remote_tool(
            State(captured): State<Arc<Mutex<Vec<Value>>>>,
            headers: HeaderMap,
            Json(request): Json<Value>,
        ) -> Json<RemoteToolResponse> {
            captured.lock().await.push(json!({
                "authorization": headers
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok()),
                "request": request,
            }));
            Json(RemoteToolResponse {
                output: "remote evidence".to_owned(),
                added_lines: None,
                deleted_lines: None,
            })
        }

        let captured = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn({
            let captured = captured.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new()
                        .route("/api/remote/tools/execute", post(capture_remote_tool))
                        .with_state(captured),
                )
                .await
                .unwrap();
            }
        });
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        open_db(&db)
            .unwrap()
            .execute(
                "INSERT INTO peers (
                   id, name, base_url, device_token, machine_id, hostname, deployment_role,
                   filesystem_enabled, bash_enabled, created_at
                 ) VALUES ('peer', 'Build host', ?1, 'secret-token',
                           'machine-build', 'build-1', 'executor', 1, 0, 'now')",
                [format!("http://{address}")],
            )
            .unwrap();
        let local_file = temp.path().join("local.txt");
        std::fs::write(&local_file, "local evidence").unwrap();
        let local = execute_device_tool(
            "read_file",
            json!({"path": local_file}),
            &db,
            &reqwest::Client::new(),
            true,
            false,
            watch::channel(false).1,
        )
        .await;
        assert_eq!(local.output, "local evidence");
        let invalid_target = execute_device_tool(
            "read_file",
            json!({"path": local_file, "target_device": null}),
            &db,
            &reqwest::Client::new(),
            true,
            false,
            watch::channel(false).1,
        )
        .await;
        assert_eq!(
            invalid_target.output,
            "error: target_device must be a non-empty device ID"
        );
        let remote = execute_device_tool(
            "read_file",
            json!({"path":"/remote/evidence.txt","target_device":"machine-build"}),
            &db,
            &reqwest::Client::new(),
            false,
            false,
            watch::channel(false).1,
        )
        .await;
        server.abort();
        assert_eq!(remote.output, "remote evidence");
        assert_eq!(
            captured.lock().await.as_slice(),
            &[json!({
                "authorization": "Bearer secret-token",
                "request": {
                    "name": "read_file",
                    "arguments": {"path": "/remote/evidence.txt"},
                },
            })]
        );
    }

    #[test]
    fn device_token_hash_never_contains_the_bearer_secret() {
        let secret = "mobius_device_secret";
        let digest = token_hash(secret);
        assert_eq!(digest.len(), 64);
        assert_ne!(digest, secret);
        assert!(!digest.contains(secret));
    }

    #[tokio::test]
    async fn remote_executor_enforces_the_device_token_capability_scope() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        configure_test_database(&db, "https://openai.example.com/v1");
        let secret = "mobius_remote_test_secret";
        open_db(&db)
            .unwrap()
            .execute(
                "INSERT INTO device_tokens (
                   id, label, token_hash, filesystem_enabled, bash_enabled, created_at
                 ) VALUES ('token', 'controller', ?1, 1, 0, 'now')",
                [token_hash(secret)],
            )
            .unwrap();
        let file = temp.path().join("evidence.txt");
        std::fs::write(&file, "remote evidence").unwrap();
        let state = test_state(db);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {secret}")).unwrap(),
        );
        let response = remote_execute_tool(
            State(state.clone()),
            headers.clone(),
            Json(RemoteToolRequest {
                name: "read_file".to_owned(),
                arguments: json!({"path": file}),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(response.output, "remote evidence");
        let denied = remote_execute_tool(
            State(state),
            headers,
            Json(RemoteToolRequest {
                name: "run_bash".to_owned(),
                arguments: json!({"command":"printf forbidden"}),
            }),
        )
        .await;
        assert!(matches!(denied, Err((StatusCode::FORBIDDEN, _))));
    }

    #[tokio::test]
    async fn long_history_creates_an_auditable_checkpoint_and_keeps_the_full_log() {
        async fn responses() -> String {
            let item = json!({
                "type":"message",
                "content":[{"type":"output_text","text":"Stable facts and unfinished work."}]
            });
            format!(
                "event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
                json!({"type":"response.output_item.done","item":item}),
                json!({"type":"response.completed","response":{"output":[]}})
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/responses", post(responses)))
                .await
                .unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        let mut current = 0;
        for index in 1..=17 {
            let message = append_conversation(
                &db,
                &ChatMessage {
                    role: if index % 2 == 0 { "assistant" } else { "user" }.to_owned(),
                    content: Value::String(format!("message {index}: {}", "x".repeat(6_000))),
                    images: None,
                    tool_call_id: None,
                    tool_calls: None,
                },
                None,
            )
            .unwrap();
            current = message.id;
        }
        create_agent_run(&db, "checkpoint-run", current).unwrap();
        let config = Config {
            root_user_id: "root".to_owned(),
            auth_url: "https://auth.example.com".to_owned(),
            openai_base_url: format!("http://{address}"),
            openai_api_key: "test".to_owned(),
            default_model: DEFAULT_MODEL_ID.to_owned(),
            filesystem_tools_enabled: false,
            bash_tools_enabled: false,
            web_search_enabled: false,
            image_generation_enabled: false,
            machine_id: "machine".to_owned(),
            deployment_role: "controller".to_owned(),
        };
        let (events, mut received) = mpsc::channel(4);
        let items = compile_main_context(
            &reqwest::Client::new(),
            &config,
            &db,
            current,
            &AgentEventSink {
                run_id: "checkpoint-run",
                sender: &events,
            },
            watch::channel(false).1,
        )
        .await
        .unwrap();
        server.abort();
        assert_eq!(load_conversation(&db).unwrap().len(), 17);
        assert_eq!(items.len(), CONTEXT_TAIL_MESSAGES + 1);
        assert_eq!(items[0]["role"], "developer");
        let checkpoint = load_latest_checkpoint(&open_db(&db).unwrap(), i64::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.through_message_id, 5);
        assert_eq!(checkpoint.summary, "Stable facts and unfinished work.");
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::Status { stage, .. }) if stage == "checkpointing"
        ));
        assert!(matches!(
            received.recv().await,
            Some(AgentEvent::Checkpoint { id, .. }) if id == checkpoint.id
        ));
    }

    #[tokio::test]
    async fn completed_subthread_is_reaped_into_the_single_main_conversation() {
        async fn responses() -> String {
            let item = json!({
                "type":"message",
                "content":[{"type":"output_text","text":"Background verification passed."}]
            });
            format!(
                "event: response.output_item.done\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
                json!({"type":"response.output_item.done","item":item}),
                json!({"type":"response.completed","response":{"output":[]}})
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/responses", post(responses)))
                .await
                .unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        bootstrap_database(&db).unwrap();
        configure_test_database(&db, &format!("http://{address}"));
        let user = append_conversation(
            &db,
            &ChatMessage {
                role: "user".to_owned(),
                content: Value::String("verify in the background".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
        )
        .unwrap();
        create_agent_run(&db, "main-run", user.id).unwrap();
        let fork = execute_fork_subthread(
            &db,
            "main-run",
            &[json!({"role":"user","content":"verify in the background"})],
            json!({"title":"Verification","task":"Run verification"}),
        );
        assert!(!fork.output.starts_with("error:"));
        let job = claim_queued_subthreads(&db).unwrap().remove(0);
        run_subthread(test_state(db.clone()), job).await;
        server.abort();
        assert!(load_subthreads(&db).unwrap().is_empty());
        let (status, result) = open_db(&db)
            .unwrap()
            .query_row("SELECT status, result FROM subthreads LIMIT 1", [], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(result.as_deref(), Some("Background verification passed."));
        let messages = load_conversation(&db).unwrap();
        assert!(
            messages
                .last()
                .unwrap()
                .content
                .contains("Background task completed")
        );
        assert!(
            messages
                .last()
                .unwrap()
                .content
                .contains("Background verification passed.")
        );
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
                output: Some("README contents".to_owned()),
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
        append_conversation_for_run(
            &db,
            &ChatMessage {
                role: "assistant".to_owned(),
                content: Value::String("The README was inspected.".to_owned()),
                images: None,
                tool_call_id: None,
                tool_calls: None,
            },
            None,
            Some("run_1"),
        )
        .unwrap();
        let history = load_history_for_run(&db, user.id).unwrap();
        let assistant = history
            .iter()
            .find(|message| message.role == "assistant")
            .unwrap();
        assert!(
            assistant
                .content
                .contains("Tool result read_file: README contents")
        );
        assert!(assistant.content.contains("The README was inspected."));
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
    fn bootstrap_removes_legacy_work_item_tables() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("default.sqlite3");
        let connection = open_db(&db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE work_items (
                   id INTEGER PRIMARY KEY,
                   title TEXT NOT NULL
                 );
                 CREATE TABLE work_item_dependencies (
                   work_item_id INTEGER NOT NULL REFERENCES work_items(id),
                   depends_on_id INTEGER NOT NULL REFERENCES work_items(id)
                 );
                 INSERT INTO work_items (id, title) VALUES (1, 'legacy');
                 INSERT INTO work_item_dependencies (work_item_id, depends_on_id) VALUES (1, 1);",
            )
            .unwrap();
        drop(connection);
        bootstrap_database(&db).unwrap();
        let connection = open_db(&db).unwrap();
        for table in ["work_items", "work_item_dependencies"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!exists, "legacy table {table} should be removed");
        }
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
    fn disabled_toolsets_omit_tools_and_tool_choice() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
        );
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
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
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].get("name").and_then(Value::as_str),
            Some("run_bash")
        );
    }

    #[test]
    fn instructions_encode_the_one_more_step_philosophy() {
        let body = responses_request_body(
            "gpt-5",
            &[],
            false,
            false,
            false,
            false,
            &SkillCatalog::default(),
        );
        let instructions = body["instructions"].as_str().unwrap();
        assert!(instructions.contains("one more step"));
        assert!(instructions.contains("let each result inform what comes next"));
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
    fn responses_input_preserves_image_generation_result_without_action_or_size() {
        let input = response_output_for_input(vec![json!({
            "type": "image_generation_call",
            "id": "image_1",
            "status": "completed",
            "action": {"type": "generate"},
            "size": "1254x1254",
            "background": "transparent",
            "output_format": "png",
            "quality": "medium",
            "result": "aW1hZ2U=",
            "revised_prompt": "A Mobius logo.",
        })]);
        assert_eq!(
            input,
            vec![json!({
                "type": "image_generation_call",
                "id": "image_1",
                "status": "completed",
                "background": "transparent",
                "output_format": "png",
                "quality": "medium",
                "result": "aW1hZ2U=",
                "revised_prompt": "A Mobius logo.",
            })]
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
                "action": {"type": "search", "query": "Mobius architecture"},
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
                if name == "web_search" && arguments["query"] == "Mobius architecture"
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
                    {"type":"image_generation_call","id":"image_1","status":"completed","action":{"type":"generate"},"size":"1254x1254","background":"transparent","output_format":"png","quality":"medium","result":"aW1hZ2U=","revised_prompt":"A Mobius logo."},
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
            deployment_role: "controller".to_owned(),
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
        let images = reply.message.images.as_ref().unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].id, "image_1");
        assert_eq!(images[0].data, "aW1hZ2U=");
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
            &json!({
                "type": "image_generation_call",
                "id": "image_1",
                "status": "completed",
                "background": "transparent",
                "output_format": "png",
                "quality": "medium",
                "result": "aW1hZ2U=",
                "revised_prompt": "A Mobius logo.",
            })
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
