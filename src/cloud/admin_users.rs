use super::*;

#[derive(Serialize)]
pub(super) struct Users {
    generated_at: i64,
    items: Vec<UserSummary>,
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
    in_flight: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cached_tokens: i64,
    cache_hit_rate: Option<f64>,
    history_records: i64,
    threads: i64,
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
    tokio::task::spawn_blocking(move || load(&state, &identity.user.id))
        .await
        .map_err(ApiError::internal)?
        .map(Json)
}

fn load(state: &AppState, root_user_id: &str) -> Result<Users, ApiError> {
    let mut items = Vec::new();
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
        let (metrics, error) = match metrics(&path) {
            Ok(metrics) => (Some(metrics), None),
            Err(error) => {
                tracing::error!(user_id = id, %error, "could not read user metrics");
                (None, Some("user_metrics_unavailable".to_owned()))
            }
        };
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

fn metrics(path: &Path) -> Result<Metrics> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(1))?;
    let mut metrics = connection.query_row("SELECT COUNT(*),
        COALESCE(SUM(status='in_flight'),0),
        COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cached_tokens),0),
        (SELECT COUNT(*) FROM history_records), (SELECT COUNT(*) FROM threads)
        FROM reasoning_audits", [], |row| {
        let input_tokens: i64 = row.get(2)?;
        let output_tokens: i64 = row.get(3)?;
        let cached_tokens: i64 = row.get(4)?;
        Ok(Metrics {
            requests: row.get(0)?, in_flight: row.get(1)?, input_tokens, output_tokens,
            total_tokens: input_tokens + output_tokens, cached_tokens,
            cache_hit_rate: (input_tokens > 0).then(|| cached_tokens as f64 / input_tokens as f64),
            history_records: row.get(5)?, threads: row.get(6)?,
            sqlite_bytes: 0, sqlite_main_bytes: 0, sqlite_wal_bytes: 0, sqlite_shm_bytes: 0,
        })
    })?;
    metrics.sqlite_main_bytes = fs::metadata(path)?.len();
    metrics.sqlite_wal_bytes = file_size(&PathBuf::from(format!("{}-wal", path.display())))?;
    metrics.sqlite_shm_bytes = file_size(&PathBuf::from(format!("{}-shm", path.display())))?;
    metrics.sqlite_bytes =
        metrics.sqlite_main_bytes + metrics.sqlite_wal_bytes + metrics.sqlite_shm_bytes;
    Ok(metrics)
}
