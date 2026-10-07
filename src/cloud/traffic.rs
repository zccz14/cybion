use super::*;
use std::sync::{
    Mutex as SyncMutex,
    atomic::{AtomicU64, Ordering},
};

#[derive(Default)]
pub(super) struct Counters {
    worker_received: AtomicU64,
    worker_sent: AtomicU64,
    upstream_received: AtomicU64,
    upstream_sent: AtomicU64,
}

#[derive(Clone, Default, Serialize)]
pub(super) struct Snapshot {
    pub worker_received_bytes: u64,
    pub worker_sent_bytes: u64,
    pub upstream_received_bytes: u64,
    pub upstream_sent_bytes: u64,
}

impl Counters {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            worker_received_bytes: self.worker_received.load(Ordering::Relaxed),
            worker_sent_bytes: self.worker_sent.load(Ordering::Relaxed),
            upstream_received_bytes: self.upstream_received.load(Ordering::Relaxed),
            upstream_sent_bytes: self.upstream_sent.load(Ordering::Relaxed),
        }
    }
}

pub(super) struct Monitor {
    path: PathBuf,
    users: SyncMutex<HashMap<String, Arc<Counters>>>,
}

impl Monitor {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS user_traffic (
            user_id TEXT PRIMARY KEY,
            worker_received_bytes INTEGER NOT NULL,
            worker_sent_bytes INTEGER NOT NULL,
            upstream_received_bytes INTEGER NOT NULL,
            upstream_sent_bytes INTEGER NOT NULL
        );",
        )?;
        let legacy_since: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('user_traffic') WHERE name='since')",
            [],
            |row| row.get(0),
        )?;
        if legacy_since {
            // COMPATIBILITY: administrator databases created before the traffic start
            // date was removed carry a NOT NULL `since` column that rejects inserts
            // which no longer supply it. Retire this migration after an audit confirms
            // pragma_table_info('user_traffic') has no `since` column on every deployed
            // administrator database; keep the preservation regression test.
            connection.execute_batch("ALTER TABLE user_traffic DROP COLUMN since;")?;
        }
        let mut statement = connection.prepare("SELECT user_id,worker_received_bytes,worker_sent_bytes,upstream_received_bytes,upstream_sent_bytes FROM user_traffic")?;
        let users = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Arc::new(Counters {
                        worker_received: AtomicU64::new(row.get(1)?),
                        worker_sent: AtomicU64::new(row.get(2)?),
                        upstream_received: AtomicU64::new(row.get(3)?),
                        upstream_sent: AtomicU64::new(row.get(4)?),
                    }),
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(Self {
            path: path.to_owned(),
            users: SyncMutex::new(users),
        })
    }

    pub fn for_user(&self, user_id: &str) -> Arc<Counters> {
        self.users
            .lock()
            .expect("traffic registry poisoned")
            .entry(user_id.to_owned())
            .or_default()
            .clone()
    }

    pub fn snapshot(&self, user_id: &str) -> Option<Snapshot> {
        self.users
            .lock()
            .expect("traffic registry poisoned")
            .get(user_id)
            .map(|c| c.snapshot())
    }

    pub fn persist(&self) -> Result<()> {
        let snapshots: Vec<_> = self
            .users
            .lock()
            .expect("traffic registry poisoned")
            .iter()
            .map(|(id, counters)| (id.clone(), counters.snapshot()))
            .collect();
        let mut connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let transaction = connection.transaction()?;
        for (id, s) in snapshots {
            transaction.execute(
                "INSERT INTO user_traffic VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(user_id) DO UPDATE SET
                worker_received_bytes=excluded.worker_received_bytes,
                worker_sent_bytes=excluded.worker_sent_bytes,
                upstream_received_bytes=excluded.upstream_received_bytes,
                upstream_sent_bytes=excluded.upstream_sent_bytes",
                params![
                    id,
                    s.worker_received_bytes,
                    s.worker_sent_bytes,
                    s.upstream_received_bytes,
                    s.upstream_sent_bytes,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub async fn persist_periodically(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let monitor = self.clone();
            match tokio::task::spawn_blocking(move || monitor.persist()).await {
                Ok(Ok(())) => (),
                result => tracing::error!(?result, "could not persist user traffic"),
            }
        }
    }
}

pub(super) async fn worker_auth(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<HashMap<String, String>>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user = worker_identity(
        &state,
        request.headers(),
        path["user_id"].clone(),
        path["worker_id"].clone(),
    )
    .await?;
    let counters = state.traffic.for_user(&user.id);
    let (mut parts, body) = request.into_parts();
    parts.extensions.insert(user);
    let received = counters.clone();
    let body = Body::from_stream(body.into_data_stream().inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            received
                .worker_received
                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
    }));
    let response = next.run(Request::from_parts(parts, body)).await;
    let (parts, body) = response.into_parts();
    let body = Body::from_stream(body.into_data_stream().inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            counters
                .worker_sent
                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
    }));
    Ok(Response::from_parts(parts, body))
}

pub(super) fn upstream_request(
    request: reqwest::RequestBuilder,
    counters: Option<Arc<Counters>>,
) -> Result<(reqwest::Client, reqwest::Request), ApiError> {
    let (client, request) = request.build_split();
    let mut request = request?;
    if let Some(counters) = counters {
        let bytes = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .ok_or_else(|| ApiError::internal("upstream request must have a buffered JSON body"))?
            .to_vec();
        request
            .headers_mut()
            .insert(header::CONTENT_LENGTH, bytes.len().into());
        *request.body_mut() = Some(reqwest::Body::wrap_stream(futures_util::stream::once(
            async move {
                counters
                    .upstream_sent
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                Ok::<_, Infallible>(bytes)
            },
        )));
    }
    Ok((client, request))
}

pub(super) fn upstream_response(
    response: reqwest::Response,
    counters: Option<Arc<Counters>>,
) -> reqwest::Response {
    let Some(counters) = counters else {
        return response;
    };
    let response: axum::http::Response<reqwest::Body> = response.into();
    let (parts, body) = response.into_parts();
    let body = Body::new(body).into_data_stream().inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            counters
                .upstream_received
                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
    });
    axum::http::Response::from_parts(parts, reqwest::Body::wrap_stream(body)).into()
}
