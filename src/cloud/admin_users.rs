use super::*;

#[derive(Serialize)]
pub(super) struct Users {
    generated_at: i64,
    running: Running,
    items: Vec<UserSummary>,
}

#[derive(Serialize, Default, Clone, Debug)]
struct Running {
    total: i64,
    kernel: i64,
    inference: i64,
    device: i64,
    unattended: i64,
    longest_seconds: i64,
}

impl Running {
    fn add(&mut self, phase: Phase, since: i64, unattended: bool) {
        self.total += 1;
        match phase {
            Phase::Kernel => self.kernel += 1,
            Phase::Inference => self.inference += 1,
            Phase::Device => self.device += 1,
        }
        if unattended {
            self.unattended += 1;
        }
        self.longest_seconds = self.longest_seconds.max((now() - since).max(0));
    }

    fn merge(&mut self, other: &Running) {
        self.total += other.total;
        self.kernel += other.kernel;
        self.inference += other.inference;
        self.device += other.device;
        self.unattended += other.unattended;
        self.longest_seconds = self.longest_seconds.max(other.longest_seconds);
    }
}

#[derive(Serialize)]
struct UserSummary {
    user_id: String,
    is_admin: bool,
    metrics: Option<Metrics>,
    traffic: Option<traffic::Snapshot>,
    error: Option<String>,
}

#[derive(Serialize)]
struct Metrics {
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cached_tokens: i64,
    cache_hit_rate: Option<f64>,
    history_records: i64,
    threads: i64,
    workers: i64,
    running: Running,
    sqlite_bytes: u64,
    sqlite_main_bytes: u64,
    sqlite_wal_bytes: u64,
    sqlite_shm_bytes: u64,
}

pub(super) async fn list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Users>, ApiError> {
    if !is_admin(&state, &identity.user.id, false).await? {
        return Err(ApiError::forbidden("administrator access is required"));
    }
    let live = state.live_phases().await;
    tokio::task::spawn_blocking(move || load(&state, &identity.user.id, &live))
        .await
        .map_err(ApiError::internal)?
        .map(Json)
}

fn load(
    state: &AppState,
    root_user_id: &str,
    live: &HashMap<(String, String), (Phase, i64)>,
) -> Result<Users, ApiError> {
    let mut items = Vec::new();
    let mut running = Running::default();
    for entry in fs::read_dir(state.data_dir.join("users")).map_err(ApiError::internal)? {
        let entry = entry.map_err(ApiError::internal)?;
        let path = entry.path();
        if !entry.file_type().map_err(ApiError::internal)?.is_file()
            || path.extension().and_then(|v| v.to_str()) != Some("sqlite3")
        {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|v| v.to_str())
            .filter(|id| user_id(id).is_ok())
        else {
            continue;
        };
        let (metrics, error) = match metrics(&path, id, live) {
            Ok(metrics) => (Some(metrics), None),
            Err(error) => {
                tracing::error!(user_id = id, %error, "could not read user metrics");
                (None, Some("user_metrics_unavailable".to_owned()))
            }
        };
        if let Some(metrics) = &metrics {
            running.merge(&metrics.running);
        }
        items.push(UserSummary {
            user_id: id.to_owned(),
            is_admin: id == root_user_id,
            metrics,
            traffic: state.traffic.snapshot(id),
            error,
        });
    }
    items.sort_by(|a, b| a.user_id.cmp(&b.user_id));
    Ok(Users {
        generated_at: now(),
        running,
        items,
    })
}

fn file_size(path: &Path) -> std::io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn metrics(
    path: &Path,
    user_id: &str,
    live: &HashMap<(String, String), (Phase, i64)>,
) -> Result<Metrics> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(1))?;
    let mut metrics = match rolled(&connection)? {
        Some(metrics) => metrics,
        None => counted(&connection)?,
    };
    metrics.running = running(&connection, user_id, live)?;
    metrics.sqlite_main_bytes = fs::metadata(path)?.len();
    metrics.sqlite_wal_bytes = file_size(&PathBuf::from(format!("{}-wal", path.display())))?;
    metrics.sqlite_shm_bytes = file_size(&PathBuf::from(format!("{}-shm", path.display())))?;
    metrics.sqlite_bytes =
        metrics.sqlite_main_bytes + metrics.sqlite_wal_bytes + metrics.sqlite_shm_bytes;
    Ok(metrics)
}

type Counts = (i64, i64, i64, i64, i64, i64, i64);

/// Reads the rollup row the `USER_ROLLUP_SCHEMA` triggers maintain: seven
/// integers instead of a scan of every audit and history record. `None` when
/// the file predates the rollup, which only happens for a database no Cybion
/// build has opened yet.
fn rolled(connection: &Connection) -> Result<Option<Metrics>> {
    let row = connection.query_row(
        "SELECT requests,input_tokens,output_tokens,cached_tokens,history_records,threads,workers
           FROM user_rollup WHERE id=1",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        },
    );
    match row {
        Ok((requests, input, output, cached, history, threads, workers)) => Ok(Some(summary((
            requests, input, output, cached, history, threads, workers,
        )))),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(rusqlite::Error::SqliteFailure(_, Some(message)))
            if message.contains("no such table") =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// The pre-rollup answer, kept as the fallback and as the regression oracle:
/// the same numbers, counted from the raw rows.
fn counted(connection: &Connection) -> Result<Metrics> {
    let counts: Counts = connection.query_row(
        "SELECT COUNT(*),
        COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cached_tokens),0),
        (SELECT COUNT(*) FROM history_records), (SELECT COUNT(*) FROM threads),
        (SELECT COUNT(*) FROM workers WHERE deleted_at IS NULL)
        FROM reasoning_audits",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        },
    )?;
    Ok(summary(counts))
}

fn summary(
    (requests, input_tokens, output_tokens, cached_tokens, history, threads, workers): Counts,
) -> Metrics {
    Metrics {
        requests,
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
        cached_tokens,
        cache_hit_rate: (input_tokens > 0).then(|| cached_tokens as f64 / input_tokens as f64),
        history_records: history,
        threads,
        workers,
        running: Running::default(),
        sqlite_bytes: 0,
        sqlite_main_bytes: 0,
        sqlite_wal_bytes: 0,
        sqlite_shm_bytes: 0,
    }
}

const RUNNING_THREADS: &str = r#"
SELECT t.id, t.updated_at,
  (SELECT MAX(a.started_at) FROM reasoning_audits a
    WHERE a.thread_id=t.id AND a.status='in_flight'
      AND a.request_kind IN ('inference','compaction')),
  (SELECT MAX(COALESCE(w.started_at,w.created_at)) FROM worker_calls w
    WHERE w.thread_id=t.id AND w.caller_user_id IS NULL
      AND w.machine_id IS NULL AND w.status IN ('queued','delivered')),
  (SELECT MAX(h.created_at) FROM history_records h
    WHERE h.thread_id=t.id AND h.worker_call_id IS NOT NULL
      AND h.worker_output_phase IS NULL
      AND COALESCE(h.worker_owner_user_id,'')<>'')
FROM threads t WHERE t.status='running'
"#;

// A Thread that just started, or that the scan caught just as it finished, can
// miss the live snapshot by the width of one pass; the recovery supervisor
// re-registers a real run every five seconds, so only a Thread that stayed
// without an executor longer than this grace counts as unattended.
const UNATTENDED_GRACE_SECONDS: i64 = 30;

// ASSUMPTION: a running Thread without a process-local request is reported as
// unattended. This build runs one Controller per installation, so every live
// run has an entry in `active_requests`; after a restart the gap before the
// supervisor resumes the Thread is seconds long, and the phase falls back to
// the durable evidence below.
fn running(
    connection: &Connection,
    user_id: &str,
    live: &HashMap<(String, String), (Phase, i64)>,
) -> Result<Running> {
    let mut statement = connection.prepare(RUNNING_THREADS)?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<i64>>(2)?,
            row.get::<_, Option<i64>>(3)?,
            row.get::<_, Option<i64>>(4)?,
        ))
    })?;
    // INVARIANT: every running Thread lands in exactly one phase, so the three
    // buckets always add up to `total`.
    let mut running = Running::default();
    for row in rows {
        let (thread, updated_at, inference_since, device_since, shared_since) = row?;
        let key = (user_id.to_owned(), thread);
        let (phase, since) = match live.get(&key) {
            Some(&(phase, since)) => (phase, since),
            None => durable_phase(inference_since, device_since, shared_since, updated_at),
        };
        let unattended = !live.contains_key(&key) && now() - updated_at >= UNATTENDED_GRACE_SECONDS;
        running.add(phase, since, unattended);
    }
    Ok(running)
}

/// The durable evidence used when a running Thread has no live phase: an
/// in-flight model request is Inference, an unsettled Worker call (local or on
/// a shared device) is Device, and everything else is Controller work.
fn durable_phase(
    inference_since: Option<i64>,
    device_since: Option<i64>,
    shared_since: Option<i64>,
    updated_at: i64,
) -> (Phase, i64) {
    match (inference_since, device_since.max(shared_since)) {
        (Some(since), _) => (Phase::Inference, since),
        (None, Some(since)) => (Phase::Device, since),
        (None, None) => (Phase::Kernel, updated_at),
    }
}

#[cfg(test)]
mod tests;
