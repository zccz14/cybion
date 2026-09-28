use super::*;

mod agent;
mod document;
mod source;
#[cfg(test)]
mod tests;
mod tools;

use source::{Source, daily_source, thread_source};

const PROMPT_VERSION: i64 = 2;
const RUN_TIMEOUT_SECONDS: u64 = 1800;
const MAX_RUN_CALLS: i64 = 256;
const MAX_READ_BYTES: i64 = 64 * 1024 * 1024;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS report_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 date TEXT NOT NULL,
 thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
 language TEXT NOT NULL CHECK(language IN ('en','zh')),
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 completed_threads INTEGER NOT NULL DEFAULT 0,
 total_threads INTEGER NOT NULL,
 phase TEXT NOT NULL DEFAULT 'threads',
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS report_jobs_one_running ON report_jobs((1)) WHERE status='running';
CREATE TABLE IF NOT EXISTS report_summaries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 job_id INTEGER NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
 date TEXT NOT NULL,
 thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
 source_fingerprint TEXT NOT NULL,
 source_manifest TEXT NOT NULL,
 prompt_version INTEGER NOT NULL,
 model TEXT NOT NULL,
 upstream_id TEXT NOT NULL,
 upstream_name TEXT NOT NULL,
 upstream_url TEXT NOT NULL,
 language TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 content_json TEXT,
 error TEXT,
 started_at INTEGER NOT NULL,
 finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS report_summaries_scope ON report_summaries(date,thread_id,id DESC);
CREATE TABLE IF NOT EXISTS report_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 summary_id INTEGER NOT NULL REFERENCES report_summaries(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 input_tokens INTEGER,
 output_tokens INTEGER,
 cached_tokens INTEGER,
 error TEXT
);
CREATE INDEX IF NOT EXISTS report_requests_summary ON report_requests(summary_id,id);
CREATE TRIGGER IF NOT EXISTS reports_delete_derived_day BEFORE DELETE ON threads BEGIN
 DELETE FROM report_summaries WHERE thread_id IS NULL AND date IN (
   SELECT date FROM report_summaries WHERE thread_id=OLD.id
 );
END;
"#;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Document {
    sections: Vec<Section>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Section {
    key: String,
    items: Vec<Item>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Item {
    text: String,
    evidence: Vec<i64>,
}

#[derive(Clone, Serialize)]
pub(super) struct Summary {
    id: i64,
    date: String,
    thread_id: Option<String>,
    source_fingerprint: String,
    source_manifest: Value,
    prompt_version: i64,
    model: String,
    upstream_name: String,
    language: String,
    status: String,
    content: Option<Document>,
    error: Option<String>,
    started_at: i64,
    finished_at: Option<i64>,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    missing_usage_requests: i64,
    executor_thread_id: Option<String>,
    input_record_id: Option<i64>,
    audit_id: Option<i64>,
    execution_kind: String,
}

#[derive(Serialize)]
pub(super) struct SummaryState {
    latest: Option<Summary>,
    saved: Option<Summary>,
    stale: bool,
}

#[derive(Clone, Serialize)]
pub(super) struct Job {
    id: i64,
    date: String,
    thread_id: Option<String>,
    language: String,
    status: String,
    completed_threads: i64,
    total_threads: i64,
    phase: String,
    started_at: i64,
    finished_at: Option<i64>,
    error: Option<String>,
    executor_thread_id: Option<String>,
    input_record_id: Option<i64>,
    source_cutoff: Option<i64>,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    missing_usage_requests: i64,
}

#[derive(Serialize)]
pub(super) struct GenerationView {
    job: Option<Job>,
    running_job: Option<Job>,
    resumable_job_id: Option<i64>,
    generator: Option<Value>,
    report_thread: Option<ThreadView>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GenerateInput {
    thread_id: Option<String>,
    language: String,
}

fn job_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    Ok(Job {
        id: row.get(0)?,
        date: row.get(1)?,
        thread_id: row.get(2)?,
        language: row.get(3)?,
        status: row.get(4)?,
        completed_threads: row.get(5)?,
        total_threads: row.get(6)?,
        phase: row.get(7)?,
        started_at: row.get(8)?,
        finished_at: row.get(9)?,
        error: row.get(10)?,
        executor_thread_id: row.get(11)?,
        input_record_id: row.get(12)?,
        source_cutoff: row.get(13)?,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        missing_usage_requests: 0,
    })
}
const JOB_SELECT: &str = "SELECT id,date,thread_id,language,status,completed_threads,total_threads,phase,started_at,finished_at,error,executor_thread_id,input_record_id,source_cutoff FROM report_jobs";
fn job(connection: &Connection, id: i64) -> Result<Job, ApiError> {
    let mut job = connection.query_row(&format!("{JOB_SELECT} WHERE id=?"), [id], job_row)?;
    let usage: (i64,i64,i64,i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(a.input_tokens),0),COALESCE(SUM(a.output_tokens),0),COALESCE(SUM(a.input_tokens IS NULL OR a.output_tokens IS NULL),0) FROM reasoning_audits a JOIN report_runs r ON r.input_record_id=a.input_record_id WHERE r.job_id=?",
        [id], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    )?;
    (
        job.requests,
        job.input_tokens,
        job.output_tokens,
        job.missing_usage_requests,
    ) = usage;
    Ok(job)
}
fn running_job(connection: &Connection) -> Result<Option<Job>, ApiError> {
    let id: Option<i64> = connection
        .query_row(
            "SELECT id FROM report_jobs WHERE status='running'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    id.map(|id| job(connection, id)).transpose()
}

fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Summary> {
    let manifest: String = row.get(4)?;
    let source_manifest = serde_json::from_str(&manifest).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let content: Option<String> = row.get(10)?;
    let content = content
        .map(|text| serde_json::from_str(&text))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    Ok(Summary {
        id: row.get(0)?,
        date: row.get(1)?,
        thread_id: row.get(2)?,
        source_fingerprint: row.get(3)?,
        source_manifest,
        prompt_version: row.get(5)?,
        model: row.get(6)?,
        upstream_name: row.get(7)?,
        language: row.get(8)?,
        status: row.get(9)?,
        content,
        error: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        missing_usage_requests: 0,
        executor_thread_id: row.get(14)?,
        input_record_id: row.get(15)?,
        audit_id: row.get(16)?,
        execution_kind: row.get(17)?,
    })
}

fn summary(connection: &Connection, id: i64) -> Result<Summary, ApiError> {
    let mut result = connection.query_row(
        "SELECT id,date,thread_id,source_fingerprint,source_manifest,prompt_version,model,upstream_name,language,status,content_json,error,started_at,finished_at,executor_thread_id,input_record_id,audit_id,execution_kind FROM report_summaries WHERE id=?",
        [id], summary_row,
    ).optional()?.ok_or_else(|| ApiError::not_found("summary not found"))?;
    // COMPATIBILITY: pre-schema-19 artifacts retain standalone usage. Remove
    // the legacy reader only after retained DBs/backups have no legacy versions;
    // Controller migration tests must prove no historical usage is lost.
    let usage: (i64, i64, i64, i64) = if result.execution_kind == "thread" {
        connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0) FROM reasoning_audits WHERE id=?",
            [result.audit_id], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        )?
    } else {
        connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0) FROM report_requests WHERE summary_id=?",
            [id], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        )?
    };
    (
        result.requests,
        result.input_tokens,
        result.output_tokens,
        result.missing_usage_requests,
    ) = usage;
    Ok(result)
}

fn latest_completed(
    connection: &Connection,
    date: &str,
    thread: Option<&str>,
) -> Result<Option<Summary>, ApiError> {
    let id: Option<i64> = connection.query_row("SELECT MAX(id) FROM report_summaries WHERE date=? AND thread_id IS ? AND status='completed'", params![date,thread],|r|r.get(0))?;
    id.map(|id| summary(connection, id)).transpose()
}

fn summary_state(connection: &Connection, source: &Source) -> Result<SummaryState, ApiError> {
    let id: Option<i64> = connection.query_row(
        "SELECT MAX(id) FROM report_summaries WHERE date=? AND thread_id IS ?",
        params![source.date, source.thread_id],
        |r| r.get(0),
    )?;
    let latest = id.map(|id| summary(connection, id)).transpose()?;
    let saved = latest_completed(connection, &source.date, source.thread_id.as_deref())?;
    let stale = saved.as_ref().is_some_and(|s| {
        s.source_fingerprint != source.fingerprint || s.prompt_version != PROMPT_VERSION
    });
    Ok(SummaryState {
        latest,
        saved,
        stale,
    })
}

pub(super) fn thread_state(
    connection: &Connection,
    date: NaiveDate,
    id: &str,
) -> Result<SummaryState, ApiError> {
    summary_state(connection, &thread_source(connection, date, id)?)
}
pub(super) fn day_state(
    connection: &Connection,
    date: NaiveDate,
) -> Result<SummaryState, ApiError> {
    summary_state(connection, &daily_source(connection, date)?)
}
pub(super) fn view(connection: &Connection, date: &str) -> Result<GenerationView, ApiError> {
    let last = connection
        .query_row(
            &format!("{JOB_SELECT} WHERE date=? ORDER BY id DESC LIMIT 1"),
            [date],
            job_row,
        )
        .optional()?;
    let thread = agent::report_thread(connection)?;
    let defaults = load_thread_defaults(connection)?;
    let (model, upstream_id) = thread
        .as_ref()
        .map(|thread| (thread.model.clone(), thread.upstream_id.clone()))
        .unwrap_or((defaults.model, defaults.upstream_id));
    let upstream = upstreams::for_thread_id(connection, upstream_id.as_deref())?;
    Ok(GenerationView {
        job: last.map(|item| job(connection, item.id)).transpose()?,
        running_job: running_job(connection)?,
        resumable_job_id: thread
            .as_ref()
            .filter(|t| t.status != "running")
            .map(|t| agent::resume_candidate(connection, t))
            .transpose()?
            .flatten()
            .map(|job| job.id),
        generator: upstream.map(|u| json!({"model":model,"upstream_name":u.name})),
        report_thread: thread,
    })
}

pub(super) async fn read_summary(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<Summary>, ApiError> {
    user_db(&state, &identity.user, false, move |c| summary(c, id))
        .await
        .map(Json)
}

pub(super) fn recover(connection: &Connection) -> Result<(), ApiError> {
    let message = "Report generation interrupted by a Controller restart. Retry manually; completed summaries are retained.";
    for table in ["report_jobs", "report_summaries", "report_requests"] {
        let legacy = if table == "report_jobs" {
            " AND executor_thread_id IS NULL"
        } else {
            ""
        };
        connection.execute(
            &format!(
                "UPDATE {table} SET status='failed',finished_at=?,error=? WHERE status='running'{legacy}"
            ),
            params![now(), message],
        )?;
    }
    Ok(())
}

pub(super) use agent::{ensure_report_thread, generate};

pub(super) fn migrate(c: &Connection) -> Result<(), ApiError> {
    for (table, name, definition) in [
        (
            "report_jobs",
            "executor_thread_id",
            "TEXT REFERENCES threads(id) ON DELETE SET NULL",
        ),
        (
            "report_jobs",
            "input_record_id",
            "INTEGER REFERENCES history_records(id) ON DELETE SET NULL",
        ),
        ("report_jobs", "source_cutoff", "INTEGER"),
        (
            "report_summaries",
            "executor_thread_id",
            "TEXT REFERENCES threads(id) ON DELETE SET NULL",
        ),
        (
            "report_summaries",
            "input_record_id",
            "INTEGER REFERENCES history_records(id) ON DELETE SET NULL",
        ),
        (
            "report_summaries",
            "audit_id",
            "INTEGER REFERENCES reasoning_audits(id) ON DELETE SET NULL",
        ),
        (
            "report_summaries",
            "generator_fingerprint",
            "TEXT NOT NULL DEFAULT ''",
        ),
        (
            "report_summaries",
            "execution_kind",
            "TEXT NOT NULL DEFAULT 'legacy'",
        ),
    ] {
        let exists: bool = c.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?)"),
            [name],
            |r| r.get(0),
        )?;
        if !exists {
            c.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {name} {definition}"),
                [],
            )?;
        }
    }
    c.execute_batch(r#"
CREATE UNIQUE INDEX IF NOT EXISTS threads_one_report_thread ON threads(purpose) WHERE purpose='reports';
CREATE TABLE IF NOT EXISTS report_runs (
 input_record_id INTEGER PRIMARY KEY REFERENCES history_records(id) ON DELETE CASCADE,
 executor_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 job_id INTEGER REFERENCES report_jobs(id) ON DELETE SET NULL,
 started_at INTEGER NOT NULL,
 read_bytes INTEGER NOT NULL DEFAULT 0,
 generator_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS report_runs_job ON report_runs(job_id);
CREATE TABLE IF NOT EXISTS report_snapshots (
 id TEXT PRIMARY KEY,
 job_id INTEGER NOT NULL REFERENCES report_jobs(id) ON DELETE CASCADE,
 thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
 source_json TEXT NOT NULL,
 expected_version INTEGER,
 read_cursor INTEGER NOT NULL DEFAULT 0,
 total_units INTEGER,
 read_complete INTEGER NOT NULL DEFAULT 0,
 summary_id INTEGER REFERENCES report_summaries(id) ON DELETE SET NULL,
 write_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS report_snapshot_scope ON report_snapshots(job_id,COALESCE(thread_id,''));
CREATE TABLE IF NOT EXISTS report_source_units (
 snapshot_id TEXT NOT NULL REFERENCES report_snapshots(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,
 text TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,ordinal)
);
CREATE TRIGGER IF NOT EXISTS report_executor_delete BEFORE DELETE ON threads WHEN OLD.purpose='reports' BEGIN
 UPDATE report_jobs SET status='failed',finished_at=unixepoch(),error='Report Thread deleted; saved reports retained' WHERE executor_thread_id=OLD.id AND status='running';
 DELETE FROM report_snapshots WHERE job_id IN (SELECT id FROM report_jobs WHERE executor_thread_id=OLD.id);
END;
"#)?;
    Ok(())
}

pub(super) use agent::{
    check_budget, finish, on_continue, on_prompt, prefix, prepare_task, register_run,
};
pub(super) use tools::answer_tool;

pub(super) fn agent_config(
    model: &str,
    upstream: &Upstream,
    effort: Option<&str>,
    fast: bool,
) -> agent::Config {
    agent::Config {
        model: model.to_owned(),
        upstream_id: upstream.id.clone(),
        upstream_name: upstream.name.clone(),
        upstream_url: upstream.base_url.clone(),
        reasoning_effort: effort.unwrap_or_default().to_owned(),
        service_tier_fast: fast,
    }
}
pub(super) use agent::validate_config;
pub(super) fn failed_message(c: &Connection, input: i64) -> Result<Option<String>, ApiError> {
    let Some(id) = agent::run_job_id(c, input)? else {
        return Ok(None);
    };
    let job = job(c, id)?;
    Ok((job.status == "failed").then_some(job.error).flatten())
}
