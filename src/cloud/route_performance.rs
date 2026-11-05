//! Per-route request performance, recorded on the request path and folded into
//! the administrator database off it.
//!
//! A request pays one hash lookup and a handful of atomic adds: the middleware
//! never opens a database, never writes a row and never waits for a flush. A
//! background task drains the minutes that already closed every few seconds,
//! adds them to the minute and hour buckets of `default.sqlite3`, and prunes
//! whatever fell out of retention.
//!
//! Reads answer from those buckets, so the page costs what its window holds —
//! its buckets and the routes seen in them — never what history holds.
//!
//! A measurement is time to response headers: a streaming reply is recorded
//! when its head is ready, because streaming afterwards is not routing cost.

use super::*;
use std::collections::VecDeque;
use std::sync::{
    Mutex as SyncMutex, RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Instant;

/// Latency bands in microseconds: band `i` counts a request no slower than
/// `BANDS_US[i]`. A percentile reports the upper bound of the band it lands in,
/// so a reported percentile is never optimistic.
pub(super) const BANDS_US: [i64; 12] = [
    5_000,      // 5 ms
    10_000,     // 10 ms
    25_000,     // 25 ms
    50_000,     // 50 ms
    100_000,    // 100 ms
    250_000,    // 250 ms
    500_000,    // 500 ms
    1_000_000,  // 1 s
    2_500_000,  // 2.5 s
    5_000_000,  // 5 s
    30_000_000, // 30 s
    i64::MAX,
];
const BAND_COUNT: usize = BANDS_US.len();

/// A flush every few seconds keeps the in-memory window small; the page is at
/// most this stale.
const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// Minute buckets answer the short windows and are kept only this long; the
/// hour buckets carry everything older.
const MINUTE_RETENTION_SECONDS: i64 = 6 * 3600;
const HOUR_RETENTION_SECONDS: i64 = 30 * 24 * 3600;
/// Requests at or above this duration are also kept one by one, so the page can
/// show what went slow instead of only how many did.
const SLOW_SAMPLE_US: i64 = 1_000_000;
const SLOW_WINDOW_LIMIT: usize = 500;
const SLOW_ROWS_KEPT: i64 = 500;
const SLOW_ROWS_SHOWN: i64 = 20;

const MINUTE_TABLE: &str = "route_perf_minute";
const HOUR_TABLE: &str = "route_perf_hour";
const SLOW_TABLE: &str = "route_perf_slow";

/// One read window of the page: which bucket table answers it, and how much of
/// it to scan.
#[derive(Clone, Copy, Debug)]
pub(super) struct Window {
    pub(super) name: &'static str,
    seconds: i64,
    table: &'static str,
    bucket_seconds: i64,
}

pub(super) const WINDOWS: [Window; 4] = [
    Window {
        name: "1h",
        seconds: 3600,
        table: MINUTE_TABLE,
        bucket_seconds: 60,
    },
    Window {
        name: "6h",
        seconds: 6 * 3600,
        table: MINUTE_TABLE,
        bucket_seconds: 60,
    },
    Window {
        name: "24h",
        seconds: 24 * 3600,
        table: HOUR_TABLE,
        bucket_seconds: 3600,
    },
    Window {
        name: "7d",
        seconds: 7 * 24 * 3600,
        table: HOUR_TABLE,
        bucket_seconds: 3600,
    },
];

/// The window a page asks for; the default is the one an operator opens first.
pub(super) fn window(value: Option<&str>) -> Result<Window, ApiError> {
    let name = value.unwrap_or("24h").trim();
    WINDOWS
        .iter()
        .find(|window| window.name == name)
        .copied()
        .ok_or_else(|| ApiError::bad_request("route performance window is invalid"))
}

/// The minute a sample belongs to, plus the route, method and status it was
/// served under. A route is the matched path, so the cardinality is the
/// router's, never the caller's.
#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct Key {
    minute: i64,
    route: Arc<str>,
    method: &'static str,
    status: u16,
}

/// One accumulator per minute, route, method and status.
struct Cell {
    requests: AtomicU64,
    latency_sum_us: AtomicU64,
    latency_max_us: AtomicU64,
    bands: [AtomicU64; BAND_COUNT],
}

impl Cell {
    fn new() -> Self {
        Self {
            requests: AtomicU64::new(0),
            latency_sum_us: AtomicU64::new(0),
            latency_max_us: AtomicU64::new(0),
            bands: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }

    /// The drain reads the counters once and never resets them in place: the
    /// cell leaves the registry as a whole, so nobody writes into a drained
    /// cell and loses a sample.
    fn drain(&self) -> Drained {
        Drained {
            requests: self.requests.load(Ordering::Relaxed),
            latency_sum_us: self.latency_sum_us.load(Ordering::Relaxed),
            latency_max_us: self.latency_max_us.load(Ordering::Relaxed),
            bands: std::array::from_fn(|index| self.bands[index].load(Ordering::Relaxed)),
        }
    }

    fn was_used(&self) -> bool {
        self.requests.load(Ordering::Relaxed) > 0
    }
}

pub(super) struct Drained {
    requests: u64,
    latency_sum_us: u64,
    latency_max_us: u64,
    bands: [u64; BAND_COUNT],
}

#[derive(Clone)]
pub(super) struct SlowSample {
    sampled_at: i64,
    route: Arc<str>,
    method: &'static str,
    status: u16,
    latency_us: i64,
}

pub(super) struct Monitor {
    path: PathBuf,
    cells: RwLock<HashMap<Key, Arc<Cell>>>,
    slow: SyncMutex<VecDeque<SlowSample>>,
}

impl Monitor {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(&format!(
            "{}\n{}\n{}",
            create_table_sql(MINUTE_TABLE),
            create_table_sql(HOUR_TABLE),
            create_slow_table_sql()
        ))?;
        prune(&connection)?;
        Ok(Self {
            path: path.to_owned(),
            cells: RwLock::new(HashMap::new()),
            slow: SyncMutex::new(VecDeque::new()),
        })
    }

    /// Called from the middleware for every matched route. Nothing here waits
    /// on a database: a miss registers one cell, a hit only adds to atomics.
    pub(super) fn record(
        &self,
        route: Arc<str>,
        method: &'static str,
        status: u16,
        elapsed: Duration,
    ) {
        self.record_in(now() / 60, route, method, status, elapsed);
    }

    /// The minute is a parameter so a test can close one without waiting for
    /// the clock; the request path always passes the minute it finished in.
    pub(super) fn record_in(
        &self,
        minute: i64,
        route: Arc<str>,
        method: &'static str,
        status: u16,
        elapsed: Duration,
    ) {
        let latency_us = i64::try_from(elapsed.as_micros()).unwrap_or(i64::MAX);
        let cell = self.cell(Key {
            minute,
            route: route.clone(),
            method,
            status,
        });
        let band = BANDS_US
            .iter()
            .position(|bound| latency_us <= *bound)
            .unwrap_or(BAND_COUNT - 1);
        cell.requests.fetch_add(1, Ordering::Relaxed);
        cell.latency_sum_us
            .fetch_add(latency_us.max(0) as u64, Ordering::Relaxed);
        cell.latency_max_us
            .fetch_max(latency_us.max(0) as u64, Ordering::Relaxed);
        cell.bands[band].fetch_add(1, Ordering::Relaxed);
        if latency_us >= SLOW_SAMPLE_US {
            let mut slow = self
                .slow
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            // A window that overflows keeps its first samples rather than
            // spending the request path's time deciding which ones matter.
            if slow.len() < SLOW_WINDOW_LIMIT {
                slow.push_back(SlowSample {
                    sampled_at: now(),
                    route,
                    method,
                    status,
                    latency_us,
                });
            }
        }
    }

    fn cell(&self, key: Key) -> Arc<Cell> {
        {
            let cells = self
                .cells
                .read()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(cell) = cells.get(&key) {
                return cell.clone();
            }
        }
        self.cells
            .write()
            .unwrap_or_else(|poison| poison.into_inner())
            .entry(key)
            .or_insert_with(|| Arc::new(Cell::new()))
            .clone()
    }

    /// Moves the minutes that already closed out of memory. The minute still
    /// running keeps accumulating, and a request that lands in a drained minute
    /// opens a fresh cell that the next pass folds in.
    fn take_closed(&self, now_minute: i64) -> Vec<(Key, Drained)> {
        let mut cells = self
            .cells
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        let closed: Vec<(Key, Arc<Cell>)> = cells
            .iter()
            .filter(|(key, _)| key.minute < now_minute)
            .map(|(key, cell)| (key.clone(), cell.clone()))
            .collect();
        for (key, _) in &closed {
            cells.remove(key);
        }
        drop(cells);
        closed
            .into_iter()
            .filter(|(_, cell)| cell.was_used())
            .map(|(key, cell)| (key, cell.drain()))
            .collect()
    }

    /// The cells still in memory: the minute that has not closed yet, and any
    /// closed minute the next pass has not written. Reading them never removes
    /// anything, so the flush keeps its own claim on every sample.
    pub(super) fn live(&self) -> Vec<(Key, Drained)> {
        self.cells
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .filter(|(_, cell)| cell.was_used())
            .map(|(key, cell)| (key.clone(), cell.drain()))
            .collect()
    }

    pub(super) fn live_slow(&self) -> Vec<SlowSample> {
        self.slow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    fn take_slow(&self) -> Vec<SlowSample> {
        let mut slow = self
            .slow
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        slow.drain(..).collect()
    }

    pub(super) fn persist(&self) -> Result<()> {
        self.persist_at(now() / 60)
    }

    /// Everything up to `now_minute` counts as closed; the minute that holds it
    /// stays in memory and keeps accumulating, so a minute is never written
    /// twice for the same samples.
    pub(super) fn persist_at(&self, now_minute: i64) -> Result<()> {
        let closed = self.take_closed(now_minute);
        let slow = self.take_slow();
        if closed.is_empty() && slow.is_empty() {
            return Ok(());
        }
        let mut connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let transaction = connection.transaction()?;
        {
            let mut minute_insert = transaction.prepare_cached(&upsert_sql(MINUTE_TABLE))?;
            let mut hour_insert = transaction.prepare_cached(&upsert_sql(HOUR_TABLE))?;
            for (key, drained) in &closed {
                let at = key.minute * 60;
                minute_insert.execute(params_from_iter(values_of(at, key, drained)))?;
                hour_insert.execute(params_from_iter(values_of(
                    at.div_euclid(3600) * 3600,
                    key,
                    drained,
                )))?;
            }
        }
        for sample in &slow {
            transaction.execute(
                &format!(
                    "INSERT INTO {SLOW_TABLE} (sampled_at,route,method,status,latency_us)
                     VALUES (?1,?2,?3,?4,?5)"
                ),
                params![
                    sample.sampled_at,
                    sample.route.as_ref(),
                    sample.method,
                    i64::from(sample.status),
                    sample.latency_us,
                ],
            )?;
        }
        prune(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) async fn persist_periodically(self: Arc<Self>) {
        let mut interval = tokio::time::interval(FLUSH_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let monitor = self.clone();
            match tokio::task::spawn_blocking(move || monitor.persist()).await {
                Ok(Ok(())) => (),
                result => tracing::error!(?result, "could not persist route performance"),
            }
        }
    }
}

fn values_of(at: i64, key: &Key, drained: &Drained) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    let mut values = vec![
        Value::Integer(at),
        Value::Text(key.route.as_ref().to_owned()),
        Value::Text(key.method.to_owned()),
        Value::Integer(i64::from(key.status)),
        Value::Integer(drained.requests as i64),
        Value::Integer(drained.latency_sum_us as i64),
        Value::Integer(drained.latency_max_us as i64),
    ];
    values.extend(
        drained
            .bands
            .iter()
            .map(|count| Value::Integer(*count as i64)),
    );
    values
}

fn create_table_sql(table: &str) -> String {
    let bands: String = (0..BAND_COUNT)
        .map(|index| format!(",\n  b{index} INTEGER NOT NULL"))
        .collect();
    format!(
        "CREATE TABLE IF NOT EXISTS {table} (
  bucket_start INTEGER NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  latency_sum_us INTEGER NOT NULL,
  latency_max_us INTEGER NOT NULL{bands},
  PRIMARY KEY (bucket_start, route, method, status)
) WITHOUT ROWID;"
    )
}

fn create_slow_table_sql() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {SLOW_TABLE} (
  sampled_at INTEGER NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_us INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS route_perf_slow_at ON {SLOW_TABLE} (sampled_at DESC);"
    )
}

fn upsert_sql(table: &str) -> String {
    let columns: Vec<String> = (0..BAND_COUNT).map(|index| format!("b{index}")).collect();
    let mut values: Vec<String> = (1..=7).map(|index| format!("?{index}")).collect();
    values.extend((0..BAND_COUNT).map(|index| format!("?{}", index + 8)));
    let assignments: Vec<String> = columns
        .iter()
        .map(|column| format!("{column}={column}+excluded.{column}"))
        .collect();
    format!(
        "INSERT INTO {table} (bucket_start,route,method,status,requests,latency_sum_us,latency_max_us,{})
         VALUES ({})
         ON CONFLICT(bucket_start,route,method,status) DO UPDATE SET
           requests=requests+excluded.requests,
           latency_sum_us=latency_sum_us+excluded.latency_sum_us,
           latency_max_us=MAX(latency_max_us,excluded.latency_max_us),
           {}",
        columns.join(","),
        values.join(","),
        assignments.join(",")
    )
}

/// Retention is applied by a flush that has something to write, and once at
/// startup, so an idle deployment never opens a write transaction to delete
/// nothing.
fn prune(connection: &Connection) -> Result<()> {
    let now = now();
    connection.execute(
        &format!("DELETE FROM {MINUTE_TABLE} WHERE bucket_start < ?1"),
        [now - MINUTE_RETENTION_SECONDS],
    )?;
    connection.execute(
        &format!("DELETE FROM {HOUR_TABLE} WHERE bucket_start < ?1"),
        [now - HOUR_RETENTION_SECONDS],
    )?;
    connection.execute(
        &format!(
            "DELETE FROM {SLOW_TABLE} WHERE rowid NOT IN
             (SELECT rowid FROM {SLOW_TABLE} ORDER BY sampled_at DESC,rowid DESC LIMIT ?1)"
        ),
        [SLOW_ROWS_KEPT],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub(super) struct RoutePerformance {
    pub window: &'static str,
    pub resolution: &'static str,
    pub bucket_seconds: i64,
    pub generated_at: i64,
    /// The newest bucket this answer covers, written or still in memory, so the
    /// page can say how far its numbers reach.
    pub latest_bucket_start: Option<i64>,
    pub totals: PerformanceTotals,
    pub routes: Vec<PerformanceRoute>,
    pub series: Vec<PerformanceBucket>,
    pub slow: Vec<PerformanceSlow>,
}

#[derive(Serialize)]
pub(super) struct PerformanceTotals {
    pub requests: i64,
    /// Cumulative time spent answering in the window; the capacity view the
    /// average alone cannot give.
    pub total_us: i64,
    pub client_errors: i64,
    pub server_errors: i64,
    pub slow_requests: i64,
    pub average_us: Option<i64>,
    pub p50_us: Option<i64>,
    pub p95_us: Option<i64>,
    pub p99_us: Option<i64>,
    pub max_us: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct PerformanceRoute {
    pub route: String,
    pub method: String,
    pub requests: i64,
    pub total_us: i64,
    pub client_errors: i64,
    pub server_errors: i64,
    pub slow_requests: i64,
    pub average_us: Option<i64>,
    pub p50_us: Option<i64>,
    pub p95_us: Option<i64>,
    pub p99_us: Option<i64>,
    pub max_us: Option<i64>,
    /// The statuses this route answered with, most frequent first.
    pub statuses: Vec<PerformanceStatus>,
}

#[derive(Clone, Serialize)]
pub(super) struct PerformanceStatus {
    pub status: i64,
    pub requests: i64,
}

#[derive(Serialize)]
pub(super) struct PerformanceBucket {
    pub bucket_start: i64,
    pub requests: i64,
    pub server_errors: i64,
    pub slow_requests: i64,
    pub p95_us: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct PerformanceSlow {
    pub sampled_at: i64,
    pub route: String,
    pub method: String,
    pub status: i64,
    pub latency_us: i64,
}

/// What one route or one bucket accumulates, in the shape both the buckets and
/// the in-memory cells can contribute to.
#[derive(Clone, Default)]
struct Aggregate {
    requests: i64,
    client_errors: i64,
    server_errors: i64,
    latency_sum_us: i64,
    latency_max_us: i64,
    bands: [i64; BAND_COUNT],
}

impl Aggregate {
    fn add_bands(&mut self, bands: &[i64]) {
        for (total, count) in self.bands.iter_mut().zip(bands) {
            *total += count;
        }
    }

    fn add_drained(&mut self, status: u16, drained: &Drained) {
        let requests = drained.requests as i64;
        self.requests += requests;
        if status >= 500 {
            self.server_errors += requests;
        } else if status >= 400 {
            self.client_errors += requests;
        }
        self.latency_sum_us += drained.latency_sum_us as i64;
        self.latency_max_us = self.latency_max_us.max(drained.latency_max_us as i64);
        for (total, count) in self.bands.iter_mut().zip(drained.bands.iter()) {
            *total += *count as i64;
        }
    }

    fn add(&mut self, other: &Aggregate) {
        self.requests += other.requests;
        self.client_errors += other.client_errors;
        self.server_errors += other.server_errors;
        self.latency_sum_us += other.latency_sum_us;
        self.latency_max_us = self.latency_max_us.max(other.latency_max_us);
        self.add_bands(&other.bands);
    }
}

/// A percentile is the upper bound of the band it lands in; the open-ended last
/// band reports the slowest request actually seen.
pub(super) fn percentile(bands: &[i64], requests: i64, share: f64, max_us: i64) -> Option<i64> {
    if requests <= 0 {
        return None;
    }
    let target = (share * requests as f64).ceil() as i64;
    let mut seen = 0;
    for (index, count) in bands.iter().enumerate() {
        seen += count;
        if seen >= target {
            return Some(if BANDS_US[index] == i64::MAX {
                max_us
            } else {
                BANDS_US[index]
            });
        }
    }
    Some(max_us)
}

pub(super) fn slow_count(bands: &[i64]) -> i64 {
    bands
        .iter()
        .zip(BANDS_US)
        .filter(|(_, bound)| *bound > SLOW_SAMPLE_US)
        .map(|(count, _)| count)
        .sum()
}

fn average(total_us: i64, requests: i64) -> Option<i64> {
    (requests > 0).then(|| total_us / requests)
}

fn band_columns() -> String {
    (0..BAND_COUNT)
        .map(|index| format!("SUM(b{index})"))
        .collect::<Vec<_>>()
        .join(",")
}

/// Reads one window: the closed minutes out of the buckets, plus the minute
/// still in memory, so the page is current instead of one flush behind.
///
/// The database connection is read-only, so answering a page can never be the
/// reason a flush waits.
pub(super) fn load(
    path: &Path,
    window: Window,
    live: Vec<(Key, Drained)>,
    live_slow: Vec<SlowSample>,
) -> Result<RoutePerformance, ApiError> {
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(ApiError::internal)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(ApiError::internal)?;
    let since = now() - window.seconds;
    let (mut routes, mut statuses) = read_routes(&connection, window, since)?;
    let mut series = read_series(&connection, window, since)?;
    for (key, drained) in live {
        if key.minute * 60 < since {
            continue;
        }
        let entry = routes
            .entry((key.route.to_string(), key.method.to_owned()))
            .or_default();
        entry.add_drained(key.status, &drained);
        let statuses = statuses
            .entry((key.route.to_string(), key.method.to_owned()))
            .or_default();
        match statuses
            .iter_mut()
            .find(|status| status.status == i64::from(key.status))
        {
            Some(status) => status.requests += drained.requests as i64,
            None => statuses.push(PerformanceStatus {
                status: i64::from(key.status),
                requests: drained.requests as i64,
            }),
        }
        series
            .entry(key.minute * 60 / window.bucket_seconds * window.bucket_seconds)
            .or_default()
            .add_drained(key.status, &drained);
    }
    let totals = routes
        .values()
        .fold(Aggregate::default(), |mut totals, route| {
            totals.add(route);
            totals
        });
    let mut routes = routes
        .into_iter()
        .map(|((route, method), aggregate)| {
            let statuses = statuses.remove(&(route.clone(), method.clone()));
            performance_route(route, method, aggregate, statuses)
        })
        .collect::<Vec<_>>();
    routes.sort_by(|left, right| {
        right
            .requests
            .cmp(&left.requests)
            .then_with(|| left.route.cmp(&right.route))
            .then_with(|| left.method.cmp(&right.method))
    });
    let series = series
        .into_iter()
        .map(|(bucket_start, aggregate)| PerformanceBucket {
            bucket_start,
            requests: aggregate.requests,
            server_errors: aggregate.server_errors,
            slow_requests: slow_count(&aggregate.bands),
            p95_us: percentile(
                &aggregate.bands,
                aggregate.requests,
                0.95,
                aggregate.latency_max_us,
            ),
        })
        .collect::<Vec<_>>();
    let latest_bucket_start = series.last().map(|bucket| bucket.bucket_start);
    let slow = merge_slow(&connection, live_slow);
    Ok(RoutePerformance {
        window: window.name,
        resolution: if window.bucket_seconds < 3600 {
            "minute"
        } else {
            "hour"
        },
        bucket_seconds: window.bucket_seconds,
        generated_at: now(),
        latest_bucket_start,
        totals: PerformanceTotals {
            requests: totals.requests,
            total_us: totals.latency_sum_us,
            client_errors: totals.client_errors,
            server_errors: totals.server_errors,
            slow_requests: slow_count(&totals.bands),
            average_us: average(totals.latency_sum_us, totals.requests),
            p50_us: percentile(&totals.bands, totals.requests, 0.50, totals.latency_max_us),
            p95_us: percentile(&totals.bands, totals.requests, 0.95, totals.latency_max_us),
            p99_us: percentile(&totals.bands, totals.requests, 0.99, totals.latency_max_us),
            max_us: (totals.requests > 0).then_some(totals.latency_max_us),
        },
        routes,
        series,
        slow,
    })
}

fn performance_route(
    route: String,
    method: String,
    aggregate: Aggregate,
    statuses: Option<Vec<PerformanceStatus>>,
) -> PerformanceRoute {
    let mut statuses = statuses.unwrap_or_default();
    statuses.sort_by(|left, right| {
        right
            .requests
            .cmp(&left.requests)
            .then_with(|| left.status.cmp(&right.status))
    });
    PerformanceRoute {
        route,
        method,
        requests: aggregate.requests,
        total_us: aggregate.latency_sum_us,
        client_errors: aggregate.client_errors,
        server_errors: aggregate.server_errors,
        slow_requests: slow_count(&aggregate.bands),
        average_us: average(aggregate.latency_sum_us, aggregate.requests),
        p50_us: percentile(
            &aggregate.bands,
            aggregate.requests,
            0.50,
            aggregate.latency_max_us,
        ),
        p95_us: percentile(
            &aggregate.bands,
            aggregate.requests,
            0.95,
            aggregate.latency_max_us,
        ),
        p99_us: percentile(
            &aggregate.bands,
            aggregate.requests,
            0.99,
            aggregate.latency_max_us,
        ),
        max_us: (aggregate.requests > 0).then_some(aggregate.latency_max_us),
        statuses,
    }
}

type RouteKey = (String, String);
/// The rolled-up totals of one route and method in a window.
type RouteTable = HashMap<RouteKey, Aggregate>;
/// The statuses one route answered with, for the row's badge list.
type StatusTable = HashMap<RouteKey, Vec<PerformanceStatus>>;

fn read_routes(
    connection: &Connection,
    window: Window,
    since: i64,
) -> Result<(RouteTable, StatusTable), ApiError> {
    let table = window.table;
    let mut statement = connection
        .prepare(&format!(
            "SELECT route,method,
               SUM(requests),SUM(latency_sum_us),MAX(latency_max_us),
               SUM(CASE WHEN status>=400 AND status<500 THEN requests ELSE 0 END),
               SUM(CASE WHEN status>=500 THEN requests ELSE 0 END),
               {}
             FROM {table}
             WHERE bucket_start>=?1
             GROUP BY route,method",
            band_columns()
        ))
        .map_err(ApiError::internal)?;
    let rows = statement
        .query_map([since], |row| {
            let bands = read_bands(row, 7)?;
            let mut aggregate = Aggregate {
                requests: row.get(2)?,
                latency_sum_us: row.get(3)?,
                latency_max_us: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                client_errors: row.get(5)?,
                server_errors: row.get(6)?,
                ..Aggregate::default()
            };
            aggregate.add_bands(&bands);
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                aggregate,
            ))
        })
        .map_err(ApiError::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ApiError::internal)?;
    drop(statement);
    let mut routes: RouteTable = HashMap::new();
    for (key, aggregate) in rows {
        routes.entry(key).or_default().add(&aggregate);
    }
    let mut grouped: StatusTable = HashMap::new();
    let mut statement = connection
        .prepare(&format!(
            "SELECT route,method,status,SUM(requests)
             FROM {table}
             WHERE bucket_start>=?1
             GROUP BY route,method,status"
        ))
        .map_err(ApiError::internal)?;
    let rows = statement
        .query_map([since], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                PerformanceStatus {
                    status: row.get(2)?,
                    requests: row.get(3)?,
                },
            ))
        })
        .map_err(ApiError::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ApiError::internal)?;
    for (key, status) in rows {
        grouped.entry(key).or_default().push(status);
    }
    Ok((routes, grouped))
}

fn read_series(
    connection: &Connection,
    window: Window,
    since: i64,
) -> Result<std::collections::BTreeMap<i64, Aggregate>, ApiError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT bucket_start,SUM(requests),MAX(latency_max_us),
               SUM(CASE WHEN status>=500 THEN requests ELSE 0 END),{}
             FROM {}
             WHERE bucket_start>=?1
             GROUP BY bucket_start
             ORDER BY bucket_start",
            band_columns(),
            window.table
        ))
        .map_err(ApiError::internal)?;
    let rows = statement
        .query_map([since], |row| {
            let bands = read_bands(row, 4)?;
            let mut aggregate = Aggregate {
                requests: row.get(1)?,
                latency_max_us: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                server_errors: row.get(3)?,
                ..Aggregate::default()
            };
            aggregate.add_bands(&bands);
            Ok((row.get::<_, i64>(0)?, aggregate))
        })
        .map_err(ApiError::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ApiError::internal)?;
    let mut series = std::collections::BTreeMap::new();
    for (bucket_start, aggregate) in rows {
        series
            .entry(bucket_start)
            .or_insert_with(Aggregate::default)
            .add(&aggregate);
    }
    Ok(series)
}

fn read_bands(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Vec<i64>> {
    (0..BAND_COUNT)
        .map(|index| {
            row.get::<_, Option<i64>>(offset + index)
                .map(|value| value.unwrap_or_default())
        })
        .collect()
}

/// The slowest requests of the window: what the buckets already hold, plus
/// whatever is still in memory, so a spike shows up while it happens.
fn merge_slow(connection: &Connection, live: Vec<SlowSample>) -> Vec<PerformanceSlow> {
    let mut slow = read_slow(connection);
    slow.extend(live.into_iter().map(|sample| PerformanceSlow {
        sampled_at: sample.sampled_at,
        route: sample.route.to_string(),
        method: sample.method.to_owned(),
        status: i64::from(sample.status),
        latency_us: sample.latency_us,
    }));
    slow.sort_by(|left, right| {
        right
            .latency_us
            .cmp(&left.latency_us)
            .then_with(|| right.sampled_at.cmp(&left.sampled_at))
    });
    slow.truncate(SLOW_ROWS_SHOWN as usize);
    slow
}

fn read_slow(connection: &Connection) -> Vec<PerformanceSlow> {
    let mut statement = match connection.prepare(&format!(
        "SELECT sampled_at,route,method,status,latency_us FROM {SLOW_TABLE}
         ORDER BY latency_us DESC,sampled_at DESC LIMIT ?1"
    )) {
        Ok(statement) => statement,
        Err(error) => {
            tracing::warn!(%error, "could not read slow route samples");
            return Vec::new();
        }
    };
    statement
        .query_map([SLOW_ROWS_SHOWN], |row| {
            Ok(PerformanceSlow {
                sampled_at: row.get(0)?,
                route: row.get(1)?,
                method: row.get(2)?,
                status: row.get(3)?,
                latency_us: row.get(4)?,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not read slow route samples");
            Vec::new()
        })
}

/// The middleware: one matched-path lookup, one clock read on each side, and a
/// single `record` call. Static assets and unmatched paths carry no matched
/// path and are not part of the interface this audit measures.
pub(super) async fn measure(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Some(route) = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|matched| Arc::<str>::from(matched.as_str()))
    else {
        return next.run(request).await;
    };
    let method = method_name(request.method());
    let started = Instant::now();
    let response = next.run(request).await;
    let elapsed = started.elapsed();
    state
        .route_performance
        .record(route, method, response.status().as_u16(), elapsed);
    response
}

pub(super) fn method_name(method: &axum::http::Method) -> &'static str {
    match *method {
        axum::http::Method::GET => "GET",
        axum::http::Method::POST => "POST",
        axum::http::Method::PUT => "PUT",
        axum::http::Method::PATCH => "PATCH",
        axum::http::Method::DELETE => "DELETE",
        axum::http::Method::HEAD => "HEAD",
        axum::http::Method::OPTIONS => "OPTIONS",
        _ => "OTHER",
    }
}
