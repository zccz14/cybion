use super::*;

mod generation;
mod source;
#[cfg(test)]
mod tests;

use generation::{Generator, generate_summary};
use source::{Source, daily_source, thread_source};

const PROMPT_VERSION: i64 = 1;
const JOB_TIMEOUT_SECONDS: u64 = 1800;

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
}

#[derive(Serialize)]
pub(super) struct GenerationView {
    job: Option<Job>,
    running_job: Option<Job>,
    generator: Option<Value>,
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
    })
}
const JOB_SELECT: &str = "SELECT id,date,thread_id,language,status,completed_threads,total_threads,phase,started_at,finished_at,error FROM report_jobs";
fn job(connection: &Connection, id: i64) -> Result<Job, ApiError> {
    Ok(connection.query_row(&format!("{JOB_SELECT} WHERE id=?"), [id], job_row)?)
}
fn running_job(connection: &Connection) -> Result<Option<Job>, ApiError> {
    Ok(connection
        .query_row(&format!("{JOB_SELECT} WHERE status='running'"), [], job_row)
        .optional()?)
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
    })
}

fn summary(connection: &Connection, id: i64) -> Result<Summary, ApiError> {
    let mut result = connection.query_row(
        "SELECT id,date,thread_id,source_fingerprint,source_manifest,prompt_version,model,upstream_name,language,status,content_json,error,started_at,finished_at FROM report_summaries WHERE id=?",
        [id], summary_row,
    ).optional()?.ok_or_else(|| ApiError::not_found("summary not found"))?;
    let usage: (i64,i64,i64,i64) = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(input_tokens IS NULL OR output_tokens IS NULL),0) FROM report_requests WHERE summary_id=?",
        [id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    )?;
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
    let defaults = load_thread_defaults(connection)?;
    let upstream = upstreams::for_thread_id(connection, defaults.upstream_id.as_deref())?;
    Ok(GenerationView {
        job: last,
        running_job: running_job(connection)?,
        generator: upstream.map(|u| json!({"model":defaults.model,"upstream_name":u.name})),
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
        connection.execute(
            &format!(
                "UPDATE {table} SET status='failed',finished_at=?,error=? WHERE status='running'"
            ),
            params![now(), message],
        )?;
    }
    Ok(())
}

pub(super) async fn generate(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(date): AxumPath<String>,
    Json(input): Json<GenerateInput>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    let date = report_date(Some(&date))?;
    if date > utc_date(now())? {
        return Err(ApiError::bad_request("cannot summarize a future date"));
    }
    if !matches!(input.language.as_str(), "en" | "zh") {
        return Err(ApiError::bad_request("language must be en or zh"));
    }
    let thread = input.thread_id.map(|id| thread_id(&id)).transpose()?;
    let language = input.language;
    let prepared = user_db(&state, &identity.user, true, move |connection| {
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(active) = running_job(&tx)? {
            if active.date == date.to_string() && active.thread_id == thread && active.language == language {
                return Ok((active, None));
            }
            return Err(ApiError::conflict("another report is generating; wait for it to finish"));
        }
        let sources = match &thread {
            Some(id) => vec![thread_source(&tx, date, id)?],
            None => source::active_threads(&tx, date)?.iter()
                .map(|id| thread_source(&tx, date, id)).collect::<Result<Vec<_>, _>>()?,
        };
        if sources.is_empty() || sources.iter().any(|source| source.manifest.records.is_empty()) {
            return Err(ApiError::bad_request("no activity on this date"));
        }
        let generator = Generator::load(&tx, &language)?;
        tx.execute(
            "INSERT INTO report_jobs(date,thread_id,language,status,total_threads,started_at) VALUES(?,?,?,'running',?,?)",
            params![date.to_string(),thread,language,sources.len() as i64,now()],
        )?;
        let result = job(&tx, tx.last_insert_rowid())?;
        tx.commit()?;
        Ok((result, Some((sources, generator))))
    }).await?;
    let (job, work) = prepared;
    if let Some((sources, generator)) = work {
        let user = identity.user;
        let job_for_task = job.clone();
        tokio::spawn(async move { run_job(state, user, job_for_task, sources, generator).await });
    }
    Ok((StatusCode::ACCEPTED, Json(job)))
}

async fn run_job(
    state: AppState,
    user: User,
    job: Job,
    sources: Vec<Source>,
    generator: Generator,
) {
    let result = tokio::time::timeout(
        Duration::from_secs(JOB_TIMEOUT_SECONDS),
        run_work(&state, &user, &job, sources, &generator),
    )
    .await
    .unwrap_or_else(|_| {
        Err(ApiError::unavailable(
            "report exceeded the 30-minute job budget; retry to reuse completed summaries",
        ))
    });
    let error = result.err().map(|error| error.message);
    // RECOVERY: this is the detached job boundary. Persist terminal failures so
    // reloading the page cannot turn an interrupted request into apparent success.
    let id = job.id;
    if let Err(error) = user_db(&state, &user, false, move |connection| {
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status = if error.is_some() { "failed" } else { "completed" };
        tx.execute(
            "UPDATE report_jobs SET status=?,finished_at=?,error=? WHERE id=? AND status='running'",
            params![status,now(),error,id],
        )?;
        tx.execute(
            "UPDATE report_requests SET status='failed',finished_at=?,error=? WHERE status='running' AND summary_id IN (SELECT id FROM report_summaries WHERE job_id=?)",
            params![now(),error,id],
        )?;
        tx.execute(
            "UPDATE report_summaries SET status='failed',finished_at=?,error=? WHERE job_id=? AND status='running'",
            params![now(),error,id],
        )?;
        tx.commit()?;
        Ok(())
    }).await {
        tracing::error!(job_id=id,error=%error.message,"could not settle report job");
    }
}

async fn run_work(
    state: &AppState,
    user: &User,
    job: &Job,
    sources: Vec<Source>,
    generator: &Generator,
) -> Result<(), ApiError> {
    let mut failed = 0;
    for (index, source) in sources.into_iter().enumerate() {
        if generate_summary(state, user, job.id, source, generator)
            .await
            .is_err()
        {
            failed += 1;
        }
        let id = job.id;
        let done = index as i64 + 1;
        user_db(state, user, false, move |c| {
            c.execute(
                "UPDATE report_jobs SET completed_threads=? WHERE id=?",
                params![done, id],
            )?;
            Ok(())
        })
        .await?;
    }
    if failed > 0 {
        return Err(ApiError::unavailable(format!(
            "{failed} Thread summaries failed. Retry the failed Threads; completed summaries will be reused."
        )));
    }
    if job.thread_id.is_some() {
        return Ok(());
    }
    let date = report_date(Some(&job.date))?;
    let source = user_db(state, user, false, move |c| {
        let tx = c.transaction()?;
        let source = daily_source(&tx, date)?;
        source::require_current_children(&tx, &source)?;
        Ok(source)
    })
    .await?;
    let id = job.id;
    user_db(state, user, false, move |c| {
        c.execute("UPDATE report_jobs SET phase='daily' WHERE id=?", [id])?;
        Ok(())
    })
    .await?;
    generate_summary(state, user, job.id, source, generator).await?;
    Ok(())
}
