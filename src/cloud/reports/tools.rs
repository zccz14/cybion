use super::*;
use source::{Child, Manifest};

const PAGE_BYTES: usize = 192 * 1024;

#[derive(Clone)]
struct Snapshot {
    id: String,
    job_id: i64,
    source: Source,
    expected_version: Option<i64>,
    read_cursor: i64,
    total_units: Option<i64>,
    read_complete: bool,
    summary_id: Option<i64>,
    write_error: Option<String>,
}
fn snapshot(c: &Connection, id: &str) -> Result<Snapshot, ApiError> {
    c.query_row("SELECT id,job_id,source_json,expected_version,read_cursor,total_units,read_complete,summary_id,write_error FROM report_snapshots WHERE id=?", [id], |r| {
        let source: String = r.get(2)?;
        let source = serde_json::from_str(&source).map_err(|e|rusqlite::Error::FromSqlConversionFailure(2,rusqlite::types::Type::Text,Box::new(e)))?;
        Ok(Snapshot{id:r.get(0)?,job_id:r.get(1)?,source,expected_version:r.get(3)?,read_cursor:r.get(4)?,total_units:r.get(5)?,read_complete:r.get(6)?,summary_id:r.get(7)?,write_error:r.get(8)?})
    }).optional()?.ok_or_else(||ApiError::not_found("source snapshot not found; list the task sources again"))
}
fn scope_snapshot(
    c: &Connection,
    job: i64,
    thread: Option<&str>,
) -> Result<Option<Snapshot>, ApiError> {
    let id: Option<String> = c
        .query_row(
            "SELECT id FROM report_snapshots WHERE job_id=? AND thread_id IS ?",
            params![job, thread],
            |r| r.get(0),
        )
        .optional()?;
    id.map(|id| snapshot(c, &id)).transpose()
}
fn snapshot_view(source: &Snapshot) -> Value {
    json!({"snapshot_id":source.id,"thread_id":source.source.thread_id,"title":source.source.title,"record_count":source.source.manifest.records.len(),"source_fingerprint":source.source.fingerprint,"expected_version":source.expected_version,"read_cursor":source.read_cursor,"total_fragments":source.total_units,"read_complete":source.read_complete,"saved_version":source.summary_id,"write_error":source.write_error})
}
fn brief(summary: &Summary) -> Value {
    json!({"id":summary.id,"date":summary.date,"thread_id":summary.thread_id,"status":summary.status,"content":summary.content,"source_fingerprint":summary.source_fingerprint,"model":summary.model,"language":summary.language,"error":summary.error})
}

pub(in crate::cloud) fn capture(
    c: &Connection,
    job: &Job,
    source: Source,
) -> Result<String, ApiError> {
    let latest = latest_completed(c, &source.date, source.thread_id.as_deref())?;
    let expected = latest.as_ref().map(|s| s.id);
    let fingerprint =
        agent::run_config(c, job.input_record_id.expect("report job has a run"))?.fingerprint()?;
    let cached = match latest {
        Some(saved)
            if saved.source_fingerprint == source.fingerprint
                && saved.prompt_version == PROMPT_VERSION
                && saved.language == job.language =>
        {
            let same: bool = c.query_row(
                "SELECT generator_fingerprint=? FROM report_summaries WHERE id=?",
                params![fingerprint, saved.id],
                |r| r.get(0),
            )?;
            same.then_some(saved.id)
        }
        _ => None,
    };
    let id = Uuid::new_v4().to_string();
    c.execute("INSERT INTO report_snapshots(id,job_id,thread_id,source_json,expected_version,read_complete,summary_id) VALUES(?,?,?,?,?,?,?)",
        params![id,job.id,source.thread_id,serde_json::to_string(&source).map_err(ApiError::internal)?,expected,cached.is_some(),cached])?;
    Ok(id)
}

fn ensure_daily(c: &Connection, job: &Job) -> Result<Option<Snapshot>, ApiError> {
    if job.thread_id.is_some() {
        return Ok(None);
    }
    if let Some(existing) = scope_snapshot(c, job.id, None)? {
        return Ok(Some(existing));
    }
    let mut children = Vec::new();
    let mut records = Vec::new();
    let ids = c.prepare("SELECT id FROM report_snapshots WHERE job_id=? AND thread_id IS NOT NULL ORDER BY thread_id")?
        .query_map([job.id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if ids.len() as i64 != job.total_threads {
        return Err(ApiError::conflict(
            "a source Thread was deleted; start a new report task",
        ));
    }
    for id in ids {
        let child = snapshot(c, &id)?;
        let Some(summary_id) = child.summary_id else {
            return Ok(None);
        };
        let saved = summary(c, summary_id)?;
        if saved.source_fingerprint != child.source.fingerprint {
            return Err(ApiError::conflict(
                "child summary no longer matches the task snapshot",
            ));
        }
        children.push(Child {
            thread_id: child.source.thread_id.expect("Thread source"),
            source_fingerprint: child.source.fingerprint,
            summary_id: Some(summary_id),
        });
        records.extend(child.source.manifest.records);
    }
    records.sort_by_key(|r| r.id);
    let source = source::make_source(
        report_date(Some(&job.date))?,
        None,
        "Daily report".to_owned(),
        Manifest {
            records,
            background_input_id: None,
            children,
        },
    )?;
    let id = capture(c, job, source)?;
    snapshot(c, &id).map(Some)
}

pub(in crate::cloud) fn refresh_progress(c: &Connection, id: i64) -> Result<(), ApiError> {
    let completed: i64 = c.query_row("SELECT COUNT(*) FROM report_snapshots WHERE job_id=? AND thread_id IS NOT NULL AND summary_id IS NOT NULL",[id],|r|r.get(0))?;
    c.execute("UPDATE report_jobs SET completed_threads=?,phase=CASE WHEN ?=total_threads AND thread_id IS NULL THEN 'daily' ELSE 'threads' END WHERE id=?",params![completed,completed,id])?;
    Ok(())
}

fn active_job(c: &Connection, input: i64) -> Result<Job, ApiError> {
    let id = agent::run_job_id(c, input)?.ok_or_else(|| {
        ApiError::conflict("call cybion_list_threads to open a date-scoped report task first")
    })?;
    let job = job(c, id)?;
    if job.status != "running" || job.input_record_id != Some(input) {
        return Err(ApiError::conflict(
            "report task is not active for this turn",
        ));
    }
    Ok(job)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFilter {
    date: String,
    thread_id: Option<String>,
    language: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    filter: ListFilter,
    #[serde(default)]
    cursor: usize,
    limit: Option<usize>,
}
fn list_threads(
    c: &Connection,
    thread: &ThreadView,
    input: i64,
    args: ListArgs,
) -> Result<Value, ApiError> {
    let date = agent::generation_date(&args.filter.date)?;
    let scope = args.filter.thread_id.map(|id| thread_id(&id)).transpose()?;
    let task = agent::open_job(c, thread, input, date, scope, &args.filter.language)?;
    let limit = args.limit.unwrap_or(20).clamp(1, 50);
    let ids=c.prepare("SELECT id FROM report_snapshots WHERE job_id=? AND thread_id IS NOT NULL ORDER BY thread_id LIMIT ? OFFSET ?")?
        .query_map(params![task.id,limit as i64+1,args.cursor as i64],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let more = ids.len() > limit;
    let mut items = Vec::new();
    for id in ids.iter().take(limit) {
        items.push(snapshot_view(&snapshot(c, id)?));
    }
    Ok(
        json!({"job":task,"items":items,"next_cursor":more.then_some(args.cursor+items.len()),"done":!more,"source_scope":"work Threads only; management history excluded"}),
    )
}

fn materialize(c: &Connection, source: &Snapshot) -> Result<(), ApiError> {
    if source.total_units.is_some() {
        return Ok(());
    }
    let (mut units, background) = source::units(c, &source.source)?;
    if !background.is_empty() {
        units.insert(
            0,
            source::Unit {
                text: json!({"background_only":background,"not_citable":true}).to_string(),
            },
        );
    }
    for (i, unit) in units.iter().enumerate() {
        c.execute(
            "INSERT INTO report_source_units(snapshot_id,ordinal,text) VALUES(?,?,?)",
            params![source.id, i as i64, unit.text],
        )?;
    }
    c.execute(
        "UPDATE report_snapshots SET total_units=? WHERE id=?",
        params![units.len() as i64, source.id],
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryFilter {
    date: String,
    thread_id: String,
    kinds: Option<Vec<String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryArgs {
    filter: HistoryFilter,
    cursor: Option<i64>,
    limit: Option<usize>,
}
fn read_history(c: &Connection, input: i64, args: HistoryArgs) -> Result<Value, ApiError> {
    let job = active_job(c, input)?;
    if job.date != args.filter.date {
        return Err(ApiError::conflict(
            "history date is outside the active report task",
        ));
    }
    let id = thread_id(&args.filter.thread_id)?;
    let source = scope_snapshot(c, job.id, Some(&id))?
        .ok_or_else(|| ApiError::not_found("Thread is outside the task source snapshot"))?;
    let kinds = args.filter.kinds.unwrap_or_default();
    if kinds.iter().any(|k| {
        !matches!(
            k.as_str(),
            "input" | "response_output" | "tool_output" | "activity"
        )
    }) {
        return Err(ApiError::bad_request("unsupported history kind"));
    }
    read_page(c, input, source, args.cursor, args.limit, &kinds)
}

fn read_page(
    c: &Connection,
    input: i64,
    source: Snapshot,
    cursor: Option<i64>,
    limit: Option<usize>,
    kinds: &[String],
) -> Result<Value, ApiError> {
    materialize(c, &source)?;
    let source = snapshot(c, &source.id)?;
    let cursor = cursor.unwrap_or(source.read_cursor);
    let total = source.total_units.expect("materialized snapshot");
    if cursor < 0 || cursor > total || (kinds.is_empty() && cursor > source.read_cursor) {
        return Err(ApiError::bad_request(
            "cursor skips unread source fragments",
        ));
    }
    let limit = limit.unwrap_or(50).clamp(1, 100);
    let filtered = !kinds.is_empty();
    let rows=c.prepare("SELECT ordinal,text FROM report_source_units WHERE snapshot_id=? AND ordinal>=? AND (?=0 OR json_extract(text,'$.kind') IN (SELECT value FROM json_each(?))) ORDER BY ordinal LIMIT ?")?
        .query_map(params![source.id,cursor,filtered,serde_json::to_string(kinds).map_err(ApiError::internal)?,limit as i64+1],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut bytes = 0;
    let mut next = cursor;
    let mut records = Vec::new();
    for (ordinal, text) in rows.iter().take(limit) {
        if bytes + text.len() > PAGE_BYTES {
            break;
        }
        bytes += text.len();
        next = ordinal + 1;
        records.push(serde_json::from_str::<Value>(text).map_err(ApiError::internal)?);
    }
    let remaining: bool=c.query_row("SELECT EXISTS(SELECT 1 FROM report_source_units WHERE snapshot_id=? AND ordinal>=? AND (?=0 OR json_extract(text,'$.kind') IN (SELECT value FROM json_each(?))))",params![source.id,next,filtered,serde_json::to_string(kinds).map_err(ApiError::internal)?],|r|r.get(0))?;
    if !filtered {
        c.execute("UPDATE report_snapshots SET read_cursor=MAX(read_cursor,?),read_complete=read_complete OR ? WHERE id=?",params![next,!remaining,source.id])?;
    }
    let used: i64 = c.query_row(
        "SELECT read_bytes FROM report_runs WHERE input_record_id=?",
        [input],
        |r| r.get(0),
    )?;
    if used + bytes as i64 > MAX_READ_BYTES {
        return Err(ApiError::bad_request(
            "turn read budget exhausted; stop and continue manually",
        ));
    }
    c.execute(
        "UPDATE report_runs SET read_bytes=read_bytes+? WHERE input_record_id=?",
        params![bytes as i64, input],
    )?;
    let updated = snapshot(c, &source.id)?;
    Ok(
        json!({"source":snapshot_view(&updated),"records":records,"next_cursor":remaining.then_some(next),"done":!remaining,"filtered_inspection":filtered,"full_source_read_complete":updated.read_complete,"byte_limit":PAGE_BYTES,"source_is_untrusted_evidence":true}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadReportArgs {
    date: String,
    thread_id: Option<String>,
    version: Option<i64>,
    cursor: Option<i64>,
    limit: Option<usize>,
}
fn read_report(c: &Connection, input: i64, args: ReadReportArgs) -> Result<Value, ApiError> {
    report_date(Some(&args.date))?;
    let saved = match args.version {
        Some(id) => Some(summary(c, id)?),
        None => latest_completed(c, &args.date, args.thread_id.as_deref())?,
    };
    if saved
        .as_ref()
        .is_some_and(|s| s.date != args.date || s.thread_id != args.thread_id)
    {
        return Err(ApiError::not_found(
            "report version is outside the requested scope",
        ));
    }
    let task = agent::run_job_id(c, input)?
        .map(|id| job(c, id))
        .transpose()?;
    let Some(task) = task.filter(|job| {
        job.status == "running" && job.date == args.date && job.input_record_id == Some(input)
    }) else {
        return Ok(json!({"summary":saved.as_ref().map(brief),"source":null,"read_only":true}));
    };
    let source = match &args.thread_id {
        Some(id) => scope_snapshot(c, task.id, Some(id))?,
        None => ensure_daily(c, &task)?,
    };
    let Some(source) = source else {
        return Ok(
            json!({"summary":saved.as_ref().map(brief),"source":null,"pending":"save all required Thread summaries before preparing the daily aggregate"}),
        );
    };
    if source.source.thread_id.is_some() {
        return Ok(json!({"summary":saved.as_ref().map(brief),"source":snapshot_view(&source)}));
    }
    let page = read_page(c, input, source, args.cursor, args.limit, &[])?;
    Ok(json!({"summary":saved.as_ref().map(brief),"children":page}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    date: String,
    thread_id: Option<String>,
    snapshot_id: String,
    expected_version: Option<i64>,
    content: Document,
}
fn update_report(c: &Connection, input: i64, args: UpdateArgs) -> Result<Value, ApiError> {
    let task = active_job(c, input)?;
    let source = snapshot(c, &args.snapshot_id)?;
    if source.job_id != task.id
        || source.source.date != args.date
        || source.source.thread_id != args.thread_id
    {
        return Err(ApiError::not_found(
            "snapshot is outside the active task scope",
        ));
    }
    if !source.read_complete {
        return Err(ApiError::conflict(
            "read all unfiltered source pages before saving; limit is not coverage",
        ));
    }
    let latest = latest_completed(c, &args.date, args.thread_id.as_deref())?.map(|s| s.id);
    if latest != args.expected_version || source.expected_version != args.expected_version {
        return Err(ApiError::conflict(
            "report version changed; read the current report before updating",
        ));
    }
    // Retained IDs are checked again even after pages were materialized, so
    // deleted source evidence cannot be reintroduced by a delayed tool call.
    for record in &source.source.manifest.records {
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM history_records WHERE id=? AND kind=? AND created_at=?)",
            params![record.id, record.kind, record.created_at],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(ApiError::conflict(
                "source evidence was deleted; start a new report task",
            ));
        }
    }
    if source.source.thread_id.is_none() {
        for child in &source.source.manifest.children {
            let active = scope_snapshot(c, task.id, Some(&child.thread_id))?
                .ok_or_else(|| ApiError::conflict("source Thread was deleted"))?;
            if active.summary_id != child.summary_id {
                return Err(ApiError::conflict(
                    "child version changed; read a refreshed daily snapshot",
                ));
            }
        }
    }
    let allowed = if source.source.thread_id.is_some() {
        source
            .source
            .manifest
            .records
            .iter()
            .map(|r| r.id)
            .collect()
    } else {
        let mut allowed = HashSet::new();
        for child in &source.source.manifest.children {
            let child = summary(c, child.summary_id.expect("validated daily child"))?;
            if let Some(content) = child.content {
                allowed.extend(source::citations(&content));
            }
        }
        allowed
    };
    let keys = if source.source.thread_id.is_some() {
        &document::THREAD_SECTIONS
    } else {
        &document::DAY_SECTIONS
    };
    let content = serde_json::to_string(&args.content).map_err(ApiError::internal)?;
    document::validate(&content, keys, &allowed).map_err(|e| ApiError::bad_request(e.message))?;
    let audit: Option<i64> = c.query_row(
        "SELECT MAX(id) FROM reasoning_audits WHERE input_record_id=? AND request_kind='inference'",
        [input],
        |r| r.get(0),
    )?;
    let id = store_summary(c, &task, &source.source, Some(&content), None, audit)?;
    c.execute(
        "UPDATE report_snapshots SET summary_id=?,expected_version=?,write_error=NULL WHERE id=?",
        params![id, id, source.id],
    )?;
    if source.source.thread_id.is_some() {
        c.execute(
            "DELETE FROM report_snapshots WHERE job_id=? AND thread_id IS NULL",
            [task.id],
        )?;
    }
    refresh_progress(c, task.id)?;
    Ok(
        json!({"saved":true,"version_id":id,"date":args.date,"thread_id":args.thread_id,"source_fingerprint":source.source.fingerprint,"audit_id":audit}),
    )
}

fn store_summary(
    c: &Connection,
    job: &Job,
    source: &Source,
    content: Option<&str>,
    error: Option<&str>,
    audit: Option<i64>,
) -> Result<i64, ApiError> {
    let input = job
        .input_record_id
        .ok_or_else(|| ApiError::internal("report task has no input"))?;
    let config = agent::run_config(c, input)?;
    c.execute("INSERT INTO report_summaries(job_id,date,thread_id,source_fingerprint,source_manifest,prompt_version,model,upstream_id,upstream_name,upstream_url,language,status,content_json,error,started_at,finished_at,executor_thread_id,input_record_id,audit_id,generator_fingerprint,execution_kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'thread')",
        params![job.id,source.date,source.thread_id,source.fingerprint,serde_json::to_string(&source.manifest).map_err(ApiError::internal)?,PROMPT_VERSION,config.model,config.upstream_id,config.upstream_name,config.upstream_url,job.language,if content.is_some(){"completed"}else{"failed"},content,error,now(),now(),job.executor_thread_id,input,audit,config.fingerprint()?])?;
    Ok(c.last_insert_rowid())
}

pub(in crate::cloud) fn save_failures(
    c: &Connection,
    job: &Job,
    message: &str,
) -> Result<(), ApiError> {
    let ids = c
        .prepare("SELECT id FROM report_snapshots WHERE job_id=? AND (summary_id IS NULL OR write_error IS NOT NULL)")?
        .query_map([job.id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        store_summary(c, job, &snapshot(c, &id)?.source, None, Some(message), None)?;
    }
    Ok(())
}

fn dispatch(
    c: &Connection,
    thread: &ThreadView,
    input: i64,
    name: &str,
    arguments: &str,
) -> Result<Value, ApiError> {
    fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, ApiError> {
        serde_json::from_str(value)
            .map_err(|e| ApiError::bad_request(format!("invalid tool arguments: {e}")))
    }
    match name {
        "cybion_list_threads" => list_threads(c, thread, input, parse(arguments)?),
        "cybion_read_history" => read_history(c, input, parse(arguments)?),
        "cybion_read_report" => read_report(c, input, parse(arguments)?),
        "cybion_update_report" => update_report(c, input, parse(arguments)?),
        _ => Err(ApiError::forbidden(
            "this report Thread may only use its four Cybion tools; Worker, context and external tools are denied",
        )),
    }
}

pub(in crate::cloud) async fn answer_tool(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    input: i64,
    item: &ResponseItem,
) -> Result<Option<PendingToolCall>, ApiError> {
    let ResponseItem::FunctionCall(call) = item else {
        return match item {
            ResponseItem::Message(_) | ResponseItem::Reasoning(_) => Ok(None),
            _ => Err(ApiError::unavailable(
                "report Thread returned a prohibited non-function tool item",
            )),
        };
    };
    let call_id = call.call_id.clone();
    let name = call.name.clone();
    let args = call.arguments.clone();
    let namespace = call.namespace.clone();
    let thread = thread.clone();
    user_db(state,user,false,move|c|{
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if thread.purpose!="reports" || load_thread(&tx,&thread.id)?.purpose!="reports" { return Err(ApiError::forbidden("report tools require a report Thread")); }
        if request_superseded(&tx,&thread.id,input)? || load_thread(&tx,&thread.id)?.status!="running" { return Err(ApiError::cancelled()); }
        let existing:Option<i64>=tx.query_row("SELECT id FROM history_records WHERE thread_id=? AND id>? AND kind='tool_output' AND json_extract(payload,'$.call_id')=? ORDER BY id LIMIT 1",params![thread.id,input,call_id],|r|r.get(0)).optional()?;
        if let Some(id)=existing { return Ok(Some(PendingToolCall::Answered(id))); }
        agent::check_tool_budget(&tx,input)?;
        tx.execute_batch("SAVEPOINT report_tool_action")?;
        let result=if namespace.as_deref().is_some_and(|n|!matches!(n,""|"functions")) {
            Err(ApiError::bad_request("unsupported tool namespace"))
        } else { dispatch(&tx,&thread,input,&name,&args) };
        let data=match result {
            Ok(value)=>value,
            Err(error) if error.status.is_client_error() && !error.is_cancelled()=>{
                tx.execute_batch("ROLLBACK TO report_tool_action")?;
                if name == "cybion_update_report"
                    && let Ok(value) = serde_json::from_str::<Value>(&args)
                    && let Some(snapshot_id) = value.get("snapshot_id").and_then(Value::as_str) {
                    tx.execute("UPDATE report_snapshots SET write_error=? WHERE id=? AND job_id=(SELECT job_id FROM report_runs WHERE input_record_id=?)",params![error.message,snapshot_id,input])?;
                }
                json!({"error":error.message})
            }
            Err(error)=>return Err(error),
        };
        tx.execute_batch("RELEASE report_tool_action")?;
        let output=json!({"tool":name,"run_record_id":input,"data":data});
        let id=persist_history_record(&tx,HistoryRecordInsert{thread_id:&thread.id,kind:"tool_output",payload:&json!({"type":"function_call_output","call_id":call_id,"output":output.to_string()}),created_at:now()})?;
        tx.commit()?;
        Ok(Some(PendingToolCall::Answered(id)))
    }).await
}
