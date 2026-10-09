//! The Ultimate Machine: a bash command run on a Worker on a fixed interval.
//! A non-zero result is delivered into the machine's bound repair Thread as a
//! user message asking for a fix; a Worker that cannot run the command is
//! reported through Linkit. A machine that finds everything in order stays
//! silent — its only message is a request to make it unnecessary.

use super::*;

/// Seconds a machine command may run before the Worker kills it.
const RUN_TIMEOUT_SECONDS: i64 = 300;
/// A dispatched run older than this is treated as lost even though the Worker
/// never settled it (the device died mid-run): the scheduler notifies once and
/// the next interval retries.
const RUN_STALE_SECONDS: i64 = 900;
const TICK_SECONDS: u64 = 30;
/// Machine output is diagnostic evidence; the repair request stays bounded.
const OUTPUT_TAIL_CHARS: usize = 1_500;
const NAME_MAX_CHARS: usize = 120;
const COMMAND_MAX_CHARS: usize = 4_000;
const INTENT_MAX_CHARS: usize = 2_000;
const MIN_INTERVAL_SECONDS: i64 = 10;
const MAX_INTERVAL_SECONDS: i64 = 30 * 24 * 60 * 60;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/machines", get(list).post(create))
        .route("/api/machines/{id}", axum::routing::patch(update))
        .route("/api/machines/{id}/run", post(run_now))
}

/// What the scheduler or a settled run must do next, outside the database
/// transaction: nothing, ask the repair Thread, or tell the owner on Linkit.
#[derive(Debug)]
pub(super) enum MachineEffect {
    Silent,
    ThreadMessage { thread_id: String, text: String },
    Linkit { text: String },
}

#[derive(Serialize)]
pub(super) struct MachineView {
    id: String,
    name: String,
    worker_id: String,
    worker_label: Option<String>,
    command: String,
    intent: Option<String>,
    interval_seconds: i64,
    thread_id: String,
    thread_title: Option<String>,
    enabled: bool,
    last_run_at: Option<i64>,
    last_exit: Option<i64>,
    created_at: i64,
}

const MACHINE_VIEW_SELECT: &str = "
SELECT m.id,m.name,m.worker_id,w.label,m.command,m.intent,m.interval_seconds,m.thread_id,t.title,
       m.enabled,m.last_run_at,m.last_exit,m.created_at
FROM machines m
LEFT JOIN workers w ON w.id=m.worker_id
LEFT JOIN threads t ON t.id=m.thread_id";

fn machine_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<MachineView> {
    Ok(MachineView {
        id: row.get(0)?,
        name: row.get(1)?,
        worker_id: row.get(2)?,
        worker_label: row.get(3)?,
        command: row.get(4)?,
        intent: row.get(5)?,
        interval_seconds: row.get(6)?,
        thread_id: row.get(7)?,
        thread_title: row.get(8)?,
        enabled: row.get(9)?,
        last_run_at: row.get(10)?,
        last_exit: row.get(11)?,
        created_at: row.get(12)?,
    })
}

fn load_machine(connection: &Connection, id: &str) -> Result<MachineView, ApiError> {
    connection
        .query_row(
            &format!("{MACHINE_VIEW_SELECT} WHERE m.id=?"),
            [id],
            machine_view,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("machine not found"))
}

pub(super) async fn list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<MachineView>>, ApiError> {
    let machines = user_db(&state, &identity.user, false, |connection| {
        let mut statement =
            connection.prepare(&format!("{MACHINE_VIEW_SELECT} ORDER BY m.created_at,m.id"))?;
        let rows = statement.query_map([], machine_view)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await?;
    Ok(Json(machines))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateMachineInput {
    name: String,
    worker_id: String,
    command: String,
    intent: Option<String>,
    interval_seconds: i64,
}

pub(super) async fn create(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateMachineInput>,
) -> Result<Json<MachineView>, ApiError> {
    let name = label(&input.name, "name", NAME_MAX_CHARS)?;
    let command = machine_command(input.command)?;
    let intent = machine_intent(input.intent)?;
    let interval = validate_interval_seconds(input.interval_seconds)?;
    let worker_id = record_id(&input.worker_id)?;
    let thread = create_thread_for(
        &state,
        &identity.user,
        CreateThreadInput {
            title: Some(machine_thread_title(&name)),
            external_ref: None,
            model: None,
            upstream_id: None,
            reasoning_effort: None,
            service_tier_fast: None,
        },
        ThreadOrigin::Web,
    )
    .await?;
    let machine_id = Uuid::new_v4().to_string();
    let machine = user_db(&state, &identity.user, true, {
        let machine_id = machine_id.clone();
        let thread_id = thread.id.clone();
        move |connection| {
            let worker_exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workers WHERE deleted_at IS NULL AND id=?)",
                [&worker_id],
                |row| row.get(0),
            )?;
            if !worker_exists {
                return Err(ApiError::not_found("selected Worker not found"));
            }
            connection.execute(
                "INSERT INTO machines(id,name,worker_id,command,intent,interval_seconds,thread_id,enabled,created_at) VALUES(?,?,?,?,?,?,?,1,?)",
                params![machine_id, name, worker_id, command, intent, interval, thread_id, now()],
            )?;
            load_machine(connection, &machine_id)
        }
    })
    .await?;
    Ok(Json(machine))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateMachineInput {
    pub(super) enabled: Option<bool>,
    pub(super) name: Option<String>,
    pub(super) worker_id: Option<String>,
    pub(super) command: Option<String>,
    pub(super) intent: Option<String>,
    pub(super) interval_seconds: Option<i64>,
}

pub(super) async fn update(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UpdateMachineInput>,
) -> Result<Json<MachineView>, ApiError> {
    let id = record_id(&id)?;
    let machine = user_db(&state, &identity.user, true, move |connection| {
        update_machine(connection, &id, input)
    })
    .await?;
    Ok(Json(machine))
}

pub(super) type MachineEditRow = (String, String, String, Option<String>, i64, bool, String);

pub(super) fn update_machine(
    connection: &Connection,
    id: &str,
    input: UpdateMachineInput,
) -> Result<MachineView, ApiError> {
    let existing: Option<MachineEditRow> = connection
        .query_row(
            "SELECT name,worker_id,command,intent,interval_seconds,enabled,thread_id FROM machines WHERE id=?",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let Some((
        current_name,
        current_worker,
        current_command,
        current_intent,
        current_interval,
        current_enabled,
        thread_id,
    )) = existing
    else {
        return Err(ApiError::not_found("machine not found"));
    };
    let previous_name = current_name.clone();
    let previous_worker = current_worker.clone();
    let name = match input.name {
        Some(value) => label(&value, "name", NAME_MAX_CHARS)?,
        None => current_name,
    };
    let worker_id = match input.worker_id {
        Some(value) => {
            let worker_id = record_id(&value)?;
            let exists: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workers WHERE deleted_at IS NULL AND id=?)",
                [&worker_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(ApiError::not_found("selected Worker not found"));
            }
            worker_id
        }
        None => current_worker,
    };
    let command = match input.command {
        Some(value) => machine_command(value)?,
        None => current_command,
    };
    let intent = match input.intent {
        Some(value) => machine_intent(Some(value))?,
        None => current_intent,
    };
    let interval = match input.interval_seconds {
        Some(value) => validate_interval_seconds(value)?,
        None => current_interval,
    };
    let enabled = input.enabled.unwrap_or(current_enabled);
    if worker_id != previous_worker {
        // A new Worker starts a fresh offline episode.
        connection.execute(
            "UPDATE machines SET offline_notified_at=NULL WHERE id=?",
            [id],
        )?;
    }
    if name != previous_name {
        // Keep the auto-created Thread labeled with the machine name unless the
        // user renamed it themselves.
        connection.execute(
            "UPDATE threads SET title=?,updated_at=? WHERE id=? AND title=?",
            params![
                machine_thread_title(&name),
                now(),
                thread_id,
                machine_thread_title(&previous_name)
            ],
        )?;
    }
    connection.execute(
        "UPDATE machines SET name=?,worker_id=?,command=?,intent=?,interval_seconds=?,enabled=? WHERE id=?",
        params![name, worker_id, command, intent, interval, enabled as i64, id],
    )?;
    load_machine(connection, id)
}

pub(super) async fn run_now(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = record_id(&id)?;
    user_db(&state, &identity.user, true, move |connection| {
        let machine: Option<(String, String, String)> = connection
            .query_row(
                "SELECT worker_id,thread_id,command FROM machines WHERE id=?",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((worker_id, thread_id, command)) = machine else {
            return Err(ApiError::not_found("machine not found"));
        };
        let pending: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM worker_calls WHERE machine_id=? AND status IN ('queued','delivered'))",
            [&id],
            |row| row.get(0),
        )?;
        if pending {
            return Err(ApiError::conflict("the previous run is still pending"));
        }
        let worker = worker_snapshot(connection, &worker_id)?
            .ok_or_else(|| ApiError::not_found("selected Worker not found"))?;
        if !worker.online {
            return Err(ApiError::conflict("selected Worker is offline"));
        }
        enqueue_run(connection, &id, &worker_id, &thread_id, &command, &worker)?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::ACCEPTED)
}

fn validate_interval_seconds(value: i64) -> Result<i64, ApiError> {
    if !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&value) {
        return Err(ApiError::bad_request(format!(
            "interval_seconds must be between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS}"
        )));
    }
    Ok(value)
}

fn machine_thread_title(name: &str) -> String {
    format!("终极机器 · {name}")
}

fn machine_command(value: String) -> Result<String, ApiError> {
    let command = context_text(value, "command", COMMAND_MAX_CHARS, true)?;
    if command.is_empty() {
        return Err(ApiError::bad_request(format!(
            "command must contain 1-{COMMAND_MAX_CHARS} characters"
        )));
    }
    Ok(command)
}

fn machine_intent(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let intent = context_text(value, "intent", INTENT_MAX_CHARS, true)?;
    if intent.is_empty() {
        return Ok(None);
    }
    Ok(Some(intent))
}

type WorkerRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<i64>,
);

struct MachineWorker {
    label: String,
    hostname: Option<String>,
    version: Option<String>,
    resource: Option<String>,
    online: bool,
}

fn worker_snapshot(
    connection: &Connection,
    worker_id: &str,
) -> Result<Option<MachineWorker>, ApiError> {
    let row: Option<WorkerRow> = connection
        .query_row(
                "SELECT label,hostname,version,resource_json,status,last_seen_at FROM workers WHERE deleted_at IS NULL AND id=?",
                [worker_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
    let Some((label, hostname, version, resource, status, last_seen_at)) = row else {
        return Ok(None);
    };
    // ASSUMPTION: 'online' mirrors the dispatch-time check in
    // `enqueue_worker_call_tx`. A Worker that drops right after being seen
    // still leaves a queued call that settles when it reconnects.
    let online = status == "online"
        && last_seen_at.is_some_and(|seen| seen >= now() - WORKER_ONLINE_SECONDS);
    Ok(Some(MachineWorker {
        label,
        hostname,
        version,
        resource,
        online,
    }))
}

fn enqueue_run(
    connection: &Connection,
    machine_id: &str,
    worker_id: &str,
    thread_id: &str,
    command: &str,
    worker: &MachineWorker,
) -> Result<(), ApiError> {
    let arguments = json!({"command": command, "timeout_seconds": RUN_TIMEOUT_SECONDS}).to_string();
    connection.execute(
        "INSERT INTO worker_calls(id,worker_id,thread_id,input_record_id,name,arguments_json,status,created_at,worker_label,worker_hostname,worker_version,worker_resource_json,machine_id) VALUES(?,?,?,NULL,'bash',?,'queued',?,?,?,?,?,?)",
        params![
            Uuid::new_v4().to_string(),
            worker_id,
            thread_id,
            arguments,
            now(),
            worker.label,
            worker.hostname,
            worker.version,
            worker.resource,
            machine_id
        ],
    )?;
    connection.execute(
        "UPDATE machines SET offline_notified_at=NULL WHERE id=?",
        [machine_id],
    )?;
    Ok(())
}

pub(super) async fn supervise(state: AppState) {
    loop {
        if let Err(error) = tick(&state).await {
            tracing::warn!(error=%error.message,"Ultimate Machine tick deferred");
        }
        tokio::time::sleep(Duration::from_secs(TICK_SECONDS)).await;
    }
}

async fn tick(state: &AppState) -> Result<(), ApiError> {
    for entry in fs::read_dir(state.data_dir.join("users")).map_err(ApiError::internal)? {
        let path = entry.map_err(ApiError::internal)?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite3") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let user = user_from_id(state, id.to_owned())?;
        if let Err(error) = process_user(state, &user).await {
            tracing::warn!(user=%user.id,error=%error.message,"Ultimate Machine dispatch deferred");
        }
    }
    Ok(())
}

async fn process_user(state: &AppState, user: &User) -> Result<(), ApiError> {
    let effects = user_db(state, user, true, |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let effects = run_due_machines(&transaction)?;
        transaction.commit()?;
        Ok(effects)
    })
    .await?;
    for effect in effects {
        apply_effect(state, user, effect).await;
    }
    Ok(())
}

struct DueMachine {
    id: String,
    name: String,
    worker_id: String,
    thread_id: String,
    command: String,
    interval_seconds: i64,
    last_run_at: Option<i64>,
    offline_notified_at: Option<i64>,
}

pub(super) fn run_due_machines(connection: &Connection) -> Result<Vec<MachineEffect>, ApiError> {
    let at = now();
    let mut statement = connection.prepare(
        "SELECT id,name,worker_id,thread_id,command,interval_seconds,last_run_at,offline_notified_at FROM machines WHERE enabled=1 ORDER BY created_at,id",
    )?;
    let machines = statement
        .query_map([], |row| {
            Ok(DueMachine {
                id: row.get(0)?,
                name: row.get(1)?,
                worker_id: row.get(2)?,
                thread_id: row.get(3)?,
                command: row.get(4)?,
                interval_seconds: row.get(5)?,
                last_run_at: row.get(6)?,
                offline_notified_at: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut effects = Vec::new();
    for machine in machines {
        let latest = latest_call(connection, &machine.id)?;
        let mut ended: Option<i64> = None;
        if let Some((call_id, status, call_created)) = &latest {
            if matches!(status.as_str(), "queued" | "delivered") {
                if *call_created > at - RUN_STALE_SECONDS {
                    continue;
                }
                connection.execute(
                    "UPDATE worker_calls SET status='failed',error='ultimate machine run expired',failure_code='machine_run_expired',completed_at=? WHERE id=? AND status IN ('queued','delivered')",
                    params![at, call_id],
                )?;
                ended = Some(*call_created);
            } else if matches!(status.as_str(), "failed" | "cancelled") {
                ended = Some(*call_created);
            }
        }
        if let Some(call_created) =
            ended.filter(|call_created| *call_created > machine.last_run_at.unwrap_or(0))
        {
            connection.execute(
                "UPDATE machines SET last_run_at=?,last_exit=NULL WHERE id=?",
                params![call_created, machine.id],
            )?;
            effects.push(MachineEffect::Linkit {
                text: format!(
                    "【终极机器·{}】上次运行未能完成（Worker 中断或超时），结果未知；将按计划重试。",
                    machine.name
                ),
            });
            continue;
        }
        // The first check runs immediately after creation; later checks run one
        // interval after the previous settled run.
        if at - machine.last_run_at.unwrap_or(0) < machine.interval_seconds {
            continue;
        }
        let Some(worker) = worker_snapshot(connection, &machine.worker_id)? else {
            effects.extend(offline_notice(
                connection,
                &machine,
                at,
                format!(
                    "【终极机器·{}】未能执行：绑定的 Worker 已不存在。",
                    machine.name
                ),
            )?);
            continue;
        };
        if !worker.online {
            effects.extend(offline_notice(
                connection,
                &machine,
                at,
                format!(
                    "【终极机器·{}】未能执行：Worker「{}」当前离线；恢复后按计划继续检查。",
                    machine.name, worker.label
                ),
            )?);
            continue;
        }
        enqueue_run(
            connection,
            &machine.id,
            &machine.worker_id,
            &machine.thread_id,
            &machine.command,
            &worker,
        )?;
    }
    Ok(effects)
}

/// One Linkit notice per offline episode: the flag set here is cleared by the
/// next dispatched run, so a long outage stays quiet until it recovers.
fn offline_notice(
    connection: &Connection,
    machine: &DueMachine,
    at: i64,
    text: String,
) -> Result<Vec<MachineEffect>, ApiError> {
    if machine.offline_notified_at.is_some() {
        return Ok(Vec::new());
    }
    connection.execute(
        "UPDATE machines SET offline_notified_at=? WHERE id=?",
        params![at, machine.id],
    )?;
    Ok(vec![MachineEffect::Linkit { text }])
}

fn latest_call(
    connection: &Connection,
    machine_id: &str,
) -> Result<Option<(String, String, i64)>, ApiError> {
    Ok(connection
        .query_row(
            "SELECT id,status,created_at FROM worker_calls WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
            [machine_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

/// Settles one Worker result for a machine call. `Ok(None)` means the call is
/// not a machine call and the caller keeps its own result path.
pub(super) fn settle_call_result(
    connection: &Connection,
    worker_id: &str,
    call_id: &str,
    result_json: &str,
    status: &str,
    error_text: Option<&str>,
) -> Result<Option<MachineEffect>, ApiError> {
    let row: Option<(Option<String>, String, Option<String>)> = connection
        .query_row(
            "SELECT machine_id,status,worker_label FROM worker_calls WHERE id=? AND worker_id=?",
            params![call_id, worker_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((machine_id, current_status, worker_label)) = row else {
        return Ok(None);
    };
    let Some(machine_id) = machine_id else {
        return Ok(None);
    };
    if !matches!(current_status.as_str(), "queued" | "delivered") {
        // The scheduler already declared this run lost; keep the first stored
        // result without re-applying any effect.
        connection.execute(
            "UPDATE worker_calls SET result_json=COALESCE(result_json,?) WHERE id=?",
            params![result_json, call_id],
        )?;
        return Ok(Some(MachineEffect::Silent));
    }
    connection.execute(
        "UPDATE worker_calls SET status=?,result_json=?,error=?,completed_at=?,received_at=COALESCE(received_at,?) WHERE id=? AND worker_id=? AND status IN ('queued','delivered')",
        params![status, result_json, error_text, now(), now(), call_id, worker_id],
    )?;
    let machine: Option<(String, String, String, Option<String>)> = connection
        .query_row(
            "SELECT name,thread_id,command,intent FROM machines WHERE id=?",
            [&machine_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((name, thread_id, command, intent)) = machine else {
        return Ok(Some(MachineEffect::Silent));
    };
    let label = worker_label
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "Worker".to_owned());
    if status == "failed" {
        connection.execute(
            "UPDATE machines SET last_run_at=?,last_exit=NULL,offline_notified_at=NULL WHERE id=?",
            params![now(), machine_id],
        )?;
        let detail = error_text
            .map(|error| tail_chars(error, 400))
            .unwrap_or_else(|| "unknown error".to_owned());
        return Ok(Some(MachineEffect::Linkit {
            text: format!("【终极机器·{name}】本次执行未能完成：{detail}"),
        }));
    }
    // ASSUMPTION: a bash result carries `exit_code`; a missing value (the
    // command was killed) counts as failure (-1). Both directions stay safe:
    // a wrong success only silences this run, and a wrong failure asks the
    // repair Thread to look at the raw result.
    let exit = parse_exit(result_json);
    connection.execute(
        "UPDATE machines SET last_run_at=?,last_exit=?,offline_notified_at=NULL WHERE id=?",
        params![now(), exit, machine_id],
    )?;
    if exit == 0 {
        return Ok(Some(MachineEffect::Silent));
    }
    let output = result_text(result_json);
    let output = if output.trim().is_empty() {
        "（无输出）".to_owned()
    } else {
        tail_chars(&output, OUTPUT_TAIL_CHARS)
    };
    let intent_section = intent
        .filter(|intent| !intent.trim().is_empty())
        .map(|intent| format!("\n意图：\n{intent}\n"))
        .unwrap_or_default();
    let text = format!(
        "【终极机器·{name}】在 Worker「{label}」上执行失败：exit={exit}。\n{intent_section}\n命令：\n{command}\n\n输出尾部：\n{output}\n\n请修复，使该命令返回 0；修好后无需回复，下次运行会自动验证。"
    );
    Ok(Some(MachineEffect::ThreadMessage { thread_id, text }))
}

fn parse_exit(result_json: &str) -> i64 {
    serde_json::from_str::<Value>(result_json)
        .ok()
        .and_then(|result| result.get("exit_code").and_then(Value::as_i64))
        .unwrap_or(-1)
}

fn result_text(result_json: &str) -> String {
    let Ok(result) = serde_json::from_str::<Value>(result_json) else {
        return result_json.to_owned();
    };
    let stderr = result
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stdout = result
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if stderr.trim().is_empty() {
        stdout.to_owned()
    } else {
        stderr.to_owned()
    }
}

fn tail_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let skip = value.chars().count() - limit;
    value.chars().skip(skip).collect()
}

pub(super) async fn apply_effect(state: &AppState, user: &User, effect: MachineEffect) {
    match effect {
        MachineEffect::Silent => {}
        MachineEffect::Linkit { text } => {
            if let Err(error) = linkit_notifications::notify_text(state, user, &text).await {
                tracing::warn!(error=%error.message,"Ultimate Machine Linkit notice failed");
            }
        }
        MachineEffect::ThreadMessage { thread_id, text } => {
            let status = user_db(state, user, false, {
                let thread_id = thread_id.clone();
                move |connection| {
                    Ok(connection
                        .query_row(
                            "SELECT status FROM threads WHERE id=?",
                            [&thread_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?)
                }
            })
            .await;
            let status = match status {
                Ok(status) => status,
                Err(error) => {
                    tracing::warn!(error=%error.message,"Ultimate Machine could not read the repair Thread");
                    return;
                }
            };
            match status.as_deref() {
                None => tracing::warn!(%thread_id,"Ultimate Machine repair Thread is missing"),
                Some("running") => {
                    // Exhaustion semantics: while the repair Thread runs, new
                    // failure messages are dropped instead of queued; the run
                    // after it settles decides again.
                    tracing::info!(%thread_id,"Ultimate Machine message dropped: repair Thread is running")
                }
                Some(_) => {
                    if let Err(error) = ensure_thread_upstream(state, user, &thread_id).await {
                        tracing::warn!(error=%error.message,"Ultimate Machine repair Thread has no upstream");
                        return;
                    }
                    let input = match input_message(text, Vec::new()) {
                        Ok(input) => input,
                        Err(error) => {
                            tracing::warn!(error=%error.message,"Ultimate Machine message is not a valid input");
                            return;
                        }
                    };
                    if let Err(error) =
                        enqueue_request(state.clone(), user.clone(), thread_id, input).await
                    {
                        tracing::warn!(error=%error.message,"Ultimate Machine message was not accepted");
                    }
                }
            }
        }
    }
}
