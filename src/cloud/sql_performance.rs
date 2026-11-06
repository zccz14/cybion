//! What each SQL statement costs, measured inside SQLite and folded into the
//! administrator database off the user request path.
//!
//! A user database has one connection and one FIFO queue, so a statement that
//! walks a table holds up every request that account queued behind it. Duration
//! alone does not show that: the settlement scan this module was written for
//! finished in 18 ms — mid-table under any latency ranking — while reading
//! 141,568 rows every five seconds. So a sample carries what the statement cost
//! *and* how much it scanned, and the page ranks by cumulative time, which is
//! the column that puts a cheap-but-constant statement where it belongs.
//!
//! Everything between the callback and these counters happens on the thread
//! that owns the connection, inside the same lane this is meant to protect.
//! That fixes the design: the hot path is a hash, a probe of a fixed static
//! table and a handful of `fetch_add`s. It never takes a lock, never allocates,
//! never reads the clock and never calls back into SQLite. The minute buckets,
//! the deltas and every string live outside it.
//!
//! The counters are monotonic, and the flusher writes differences. Draining a
//! cell in place would race with a statement landing in it; keeping the reading
//! side responsible for the difference means a sample cannot be lost, and the
//! same difference answers a page without consuming it.

use super::*;
use route_performance::{BANDS_US, percentile};
use std::collections::VecDeque;
use std::collections::hash_map::DefaultHasher;
use std::ffi::CStr;
use std::hash::{Hash, Hasher};
use std::panic::Location;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

const BAND_COUNT: usize = BANDS_US.len();
/// Slots in the fixed table. A key is one statement text under one call site,
/// so the population is the codebase's `user_db` call sites times the handful
/// of statement shapes each one runs — a few hundred, not a few dozen. The
/// table is deliberately much wider than that and never grows at runtime: a key
/// that finds no free slot is counted as unattributed instead of claiming
/// memory inside a request.
const SLOTS: usize = 4096;
/// Linear probe depth before a key counts as unattributed. Eight keeps the
/// probe bound visible while tolerating occasional hash clustering at the load
/// this table runs at.
const PROBE: usize = 8;

/// A statement at or above this is also kept one by one. The settlement scan
/// this module was written for cost 18 ms warm and 92 ms cold, so a second
/// would hide exactly the case that matters.
const SLOW_SAMPLE_US: i64 = 100_000;
const SLOW_WINDOW_LIMIT: usize = 500;
const SLOW_ROWS_KEPT: i64 = 500;
const SLOW_ROWS_SHOWN: i64 = 20;

const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
const MINUTE_RETENTION_SECONDS: i64 = 6 * 3600;
const HOUR_RETENTION_SECONDS: i64 = 30 * 24 * 3600;

const MINUTE_TABLE: &str = "sql_perf_minute";
const HOUR_TABLE: &str = "sql_perf_hour";
const SLOW_TABLE: &str = "sql_perf_slow";
const TEXT_TABLE: &str = "sql_perf_text";

/// One in this many statements is timed end to end, and the average is scaled
/// back up to report what the recorder itself costs. Timing every statement
/// would double the cost of measuring it.
const SAMPLE_MASK: u64 = 0xFF;

/// The trace callback and the two clocks per statement are cheap but not free:
/// below this share of wall time the page says nothing about them.
const OVERHEAD_NOTICE_PPM: f64 = 10_000.0;

// ---------------------------------------------------------------------------
// Hot path: fixed table, relaxed atomics, no locks
// ---------------------------------------------------------------------------

struct Slot {
    /// The mixed key this slot answers, or 0 while it is free. Set once by the
    /// first statement that hits it; never cleared, so a lookup that matches is
    /// one relaxed load and the counters below are always the same statement.
    key: AtomicU64,
    statements: AtomicU64,
    latency_sum_us: AtomicU64,
    latency_max_us: AtomicU64,
    fullscan_steps: AtomicU64,
    bands: [AtomicU64; BAND_COUNT],
}

impl Slot {
    const fn new() -> Self {
        Self {
            key: AtomicU64::new(0),
            statements: AtomicU64::new(0),
            latency_sum_us: AtomicU64::new(0),
            latency_max_us: AtomicU64::new(0),
            fullscan_steps: AtomicU64::new(0),
            bands: [const { AtomicU64::new(0) }; BAND_COUNT],
        }
    }
}

/// Process-wide on purpose: every traced connection feeds it, and there is one
/// recorder in a process whatever the number of states a test builds.
static TABLE: [Slot; SLOTS] = [const { Slot::new() }; SLOTS];

static ENABLED: AtomicBool = AtomicBool::new(true);
static STATEMENTS: AtomicU64 = AtomicU64::new(0);
static RECORDER_SAMPLED: AtomicU64 = AtomicU64::new(0);
static RECORDER_NS: AtomicU64 = AtomicU64::new(0);
static UNATTRIBUTED: AtomicU64 = AtomicU64::new(0);
static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Where a statement was issued from. `Caller` is a handler reached through
/// `UserDatabases::run`; `Named` covers the patrols that open their own
/// connection on a user file (`stats::open_stats`) and have no handler.
#[derive(Clone, Copy)]
enum Origin {
    Caller(&'static Location<'static>),
    Named(&'static str),
}

thread_local! {
    static LABEL: std::cell::Cell<Option<(u64, Origin)>> = const { std::cell::Cell::new(None) };
}

/// Restores the enclosing label when it drops, so a patrol that calls into
/// another queue cannot leave its name on the caller's statements.
pub(super) struct LabelGuard {
    previous: Option<(u64, Origin)>,
}

impl Drop for LabelGuard {
    fn drop(&mut self) {
        LABEL.with(|cell| cell.set(self.previous));
    }
}

/// Names the statements issued from here until the guard drops. Called by
/// `UserDatabases::run` with the location it already reads for its own warning.
pub(super) fn enter(location: &'static Location<'static>) -> LabelGuard {
    let hash = hash_origin(&Origin::Caller(location));
    set_label(hash, Origin::Caller(location))
}

pub(super) fn enter_named(name: &'static str) -> LabelGuard {
    let origin = Origin::Named(name);
    set_label(hash_origin(&origin), origin)
}

fn set_label(hash: u64, origin: Origin) -> LabelGuard {
    let previous = LABEL.with(|cell| cell.replace(Some((hash, origin))));
    LabelGuard { previous }
}

fn current_label() -> (u64, Option<Origin>) {
    LABEL.with(|cell| match cell.get() {
        Some((hash, origin)) => (hash, Some(origin)),
        None => (0, None),
    })
}

fn hash_origin(origin: &Origin) -> u64 {
    let mut hasher = DefaultHasher::new();
    match origin {
        Origin::Caller(location) => {
            location.file().hash(&mut hasher);
            location.line().hash(&mut hasher);
            location.column().hash(&mut hasher);
        }
        Origin::Named(name) => name.hash(&mut hasher),
    }
    hasher.finish()
}

fn origin_text(origin: Option<Origin>) -> String {
    match origin {
        Some(Origin::Caller(location)) => format!(
            "{}:{}:{}",
            location.file(),
            location.line(),
            location.column()
        ),
        Some(Origin::Named(name)) => name.to_owned(),
        None => "unattributed".to_owned(),
    }
}

fn sql_hash(sql: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    sql.hash(&mut hasher);
    hasher.finish()
}

/// Collapses the whitespace a multi-line statement carries so the same
/// statement written over several lines keys to one row.
fn normalized(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut space = false;
    for character in sql.trim().chars() {
        if character.is_whitespace() {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(character);
    }
    out
}

fn band_of(latency_us: i64) -> usize {
    BANDS_US
        .iter()
        .position(|bound| latency_us <= *bound)
        .unwrap_or(BAND_COUNT - 1)
}

/// Everything the page needs that the counters cannot hold, claimed once per
/// key. Reading it never touches the hot path.
#[derive(Clone)]
struct Meta {
    sql: Arc<str>,
    caller: Arc<str>,
}

fn meta() -> &'static std::sync::Mutex<HashMap<u64, Meta>> {
    static META: std::sync::OnceLock<std::sync::Mutex<HashMap<u64, Meta>>> =
        std::sync::OnceLock::new();
    META.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn slow_window() -> &'static std::sync::Mutex<VecDeque<SlowSample>> {
    static SLOW: std::sync::OnceLock<std::sync::Mutex<VecDeque<SlowSample>>> =
        std::sync::OnceLock::new();
    SLOW.get_or_init(|| std::sync::Mutex::new(VecDeque::new()))
}

#[derive(Clone)]
struct SlowSample {
    sampled_at: i64,
    key: u64,
    latency_us: i64,
    fullscan_steps: i64,
}

/// Finds the slot for `key`, claiming one on first sight. A key that finds
/// neither a match nor a free slot within the probe depth is counted apart
/// instead of displacing an existing statement.
fn slot_for(key: u64, sql: &str, origin: Option<Origin>) -> Option<&'static Slot> {
    let start = (key & (SLOTS as u64 - 1)) as usize;
    for offset in 0..PROBE {
        let slot = &TABLE[(start + offset) % SLOTS];
        let current = slot.key.load(Ordering::Relaxed);
        if current == key {
            return Some(slot);
        }
        if current == 0
            && slot
                .key
                .compare_exchange(0, key, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            let entry = Meta {
                sql: Arc::from(sql),
                caller: Arc::from(origin_text(origin).as_str()),
            };
            meta()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(key, entry);
            return Some(slot);
        }
    }
    None
}

/// The trace callback. Runs on the connection's thread inside the user database
/// lane, so it must stay bounded: no lock, no allocation on a hit, no SQLite.
/// The signature is SQLite's: the mask comes first, then the context this was
/// installed with, then the statement and the event payload.
unsafe extern "C" fn on_profile(
    mask: std::os::raw::c_uint,
    _context: *mut std::os::raw::c_void,
    statement: *mut std::os::raw::c_void,
    nanoseconds: *mut std::os::raw::c_void,
) -> std::os::raw::c_int {
    if mask == rusqlite::ffi::SQLITE_TRACE_PROFILE as std::os::raw::c_uint
        && !statement.is_null()
        && !nanoseconds.is_null()
    {
        // A panic must not cross the FFI boundary; the recorder is a metric and
        // losing a sample is always preferable to losing the connection.
        let _ = std::panic::catch_unwind(|| {
            // SAFETY: for SQLITE_TRACE_PROFILE the fourth argument is a
            // pointer to the elapsed nanoseconds, valid for this call.
            let elapsed = unsafe { *(nanoseconds as *const u64) };
            record(statement as *mut rusqlite::ffi::sqlite3_stmt, elapsed);
        });
    }
    0
}

fn record(statement: *mut rusqlite::ffi::sqlite3_stmt, nanos: u64) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let sampled = STATEMENTS.fetch_add(1, Ordering::Relaxed);
    let timed = sampled & SAMPLE_MASK == 0;
    let started = timed.then(Instant::now);

    unsafe {
        let text = rusqlite::ffi::sqlite3_sql(statement);
        if !text.is_null() {
            let sql = normalized(&CStr::from_ptr(text).to_string_lossy());
            let (label_hash, origin) = current_label();
            let key = sql_hash(&sql) ^ label_hash.rotate_left(32);
            let key = if key == 0 { 1 } else { key };
            if let Some(slot) = slot_for(key, &sql, origin) {
                let latency_us = i64::try_from(nanos / 1_000).unwrap_or(i64::MAX);
                let steps = rusqlite::ffi::sqlite3_stmt_status(
                    statement,
                    rusqlite::ffi::SQLITE_STMTSTATUS_FULLSCAN_STEP,
                    0,
                ) as i64;
                slot.statements.fetch_add(1, Ordering::Relaxed);
                slot.latency_sum_us
                    .fetch_add(latency_us.max(0) as u64, Ordering::Relaxed);
                slot.latency_max_us
                    .fetch_max(latency_us.max(0) as u64, Ordering::Relaxed);
                slot.fullscan_steps
                    .fetch_add(steps.max(0) as u64, Ordering::Relaxed);
                slot.bands[band_of(latency_us)].fetch_add(1, Ordering::Relaxed);
                if latency_us >= SLOW_SAMPLE_US {
                    let mut slow = slow_window().lock().unwrap_or_else(|p| p.into_inner());
                    // A burst keeps its first samples rather than spending the
                    // request path's time deciding which ones matter.
                    if slow.len() < SLOW_WINDOW_LIMIT {
                        slow.push_back(SlowSample {
                            sampled_at: now(),
                            key,
                            latency_us,
                            fullscan_steps: steps.max(0),
                        });
                    }
                }
            } else {
                UNATTRIBUTED.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    if let Some(started) = started {
        RECORDER_NS.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
        RECORDER_SAMPLED.fetch_add(1, Ordering::Relaxed);
    }
}

/// Installs the profiler on one connection. Each connection keeps its own
/// tracer, so this is per open, not per statement.
pub(super) fn install(connection: &Connection) -> Result<(), ApiError> {
    STARTED.get_or_init(Instant::now);
    // SAFETY: the handle is live for as long as the connection is, and SQLite
    // accepts a trace callback at any time between open and close.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_trace_v2(
            connection.handle(),
            rusqlite::ffi::SQLITE_TRACE_PROFILE as std::os::raw::c_uint,
            Some(
                on_profile
                    as unsafe extern "C" fn(
                        std::os::raw::c_uint,
                        *mut std::os::raw::c_void,
                        *mut std::os::raw::c_void,
                        *mut std::os::raw::c_void,
                    ) -> std::os::raw::c_int,
            ),
            std::ptr::null_mut(),
        )
    };
    if rc == rusqlite::ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(ApiError::internal("could not install the SQL profiler"))
    }
}

pub(super) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub(super) fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// Reading side: one page, one difference per key
// ---------------------------------------------------------------------------

/// What one key has accumulated since the process started, read once so the
/// flusher and the page agree on what they saw.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(super) struct Counter {
    pub(super) statements: u64,
    pub(super) latency_sum_us: u64,
    pub(super) latency_max_us: u64,
    pub(super) fullscan_steps: u64,
    pub(super) bands: [u64; BAND_COUNT],
}

impl Counter {
    fn read(slot: &Slot) -> Self {
        Self {
            statements: slot.statements.load(Ordering::Relaxed),
            latency_sum_us: slot.latency_sum_us.load(Ordering::Relaxed),
            latency_max_us: slot.latency_max_us.load(Ordering::Relaxed),
            fullscan_steps: slot.fullscan_steps.load(Ordering::Relaxed),
            bands: std::array::from_fn(|index| slot.bands[index].load(Ordering::Relaxed)),
        }
    }

    /// The part of `self` that `last` does not cover. Bands, counts, sums and
    /// scan steps are differences; a maximum has no difference, so a bucket
    /// reports the maximum only while it is the highest ever seen, which keeps
    /// it monotonic without double counting.
    fn since(&self, last: &Counter) -> Self {
        Self {
            statements: self.statements.saturating_sub(last.statements),
            latency_sum_us: self.latency_sum_us.saturating_sub(last.latency_sum_us),
            latency_max_us: if self.latency_max_us > last.latency_max_us {
                self.latency_max_us
            } else {
                0
            },
            fullscan_steps: self.fullscan_steps.saturating_sub(last.fullscan_steps),
            bands: std::array::from_fn(|index| self.bands[index].saturating_sub(last.bands[index])),
        }
    }
}

fn seen() -> &'static std::sync::Mutex<HashMap<u64, Counter>> {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<HashMap<u64, Counter>>> =
        std::sync::OnceLock::new();
    SEEN.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Every claimed key with what it accumulated since the caller last took it.
/// `consume` decides whether the reading is spent; a page passes false so the
/// flush still gets its own claim on every sample.
pub(super) fn differences(consume: bool) -> Vec<(u64, Counter)> {
    let mut seen = seen().lock().unwrap_or_else(|poison| poison.into_inner());
    let mut out = Vec::new();
    for slot in TABLE.iter() {
        let key = slot.key.load(Ordering::Relaxed);
        if key == 0 {
            continue;
        }
        let current = Counter::read(slot);
        let last = seen.get(&key).copied().unwrap_or_default();
        let difference = current.since(&last);
        if difference.statements > 0 {
            out.push((key, difference));
        }
        if consume {
            seen.insert(key, current);
        }
    }
    out
}

/// The key a named statement was recorded under, for tests that need to look at
/// one statement without matching on the whole table.
#[cfg(test)]
pub(super) fn key_named(name: &str) -> Option<u64> {
    let meta = meta().lock().unwrap_or_else(|p| p.into_inner());
    meta.iter()
        .find(|(_, meta)| meta.caller.as_ref() == name)
        .map(|(key, _)| *key)
}

/// Statements the fixed table had no room for, so a test can say why nothing
/// was recorded instead of only that nothing was.
#[cfg(test)]
pub(super) fn unattributed() -> u64 {
    UNATTRIBUTED.load(Ordering::Relaxed)
}

/// What one named statement has accumulated since the process started.
#[cfg(test)]
pub(super) fn measured_named(name: &str) -> Option<Counter> {
    let key = key_named(name)?;
    TABLE
        .iter()
        .find(|slot| slot.key.load(Ordering::Relaxed) == key)
        .map(Counter::read)
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// One read window of the page: which bucket table answers it.
#[derive(Clone, Copy, Debug)]
pub(super) struct Window {
    pub(super) name: &'static str,
    seconds: i64,
    table: &'static str,
    pub(super) bucket_seconds: i64,
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

pub(super) fn window(value: Option<&str>) -> Result<Window, ApiError> {
    let name = value.unwrap_or("24h").trim();
    WINDOWS
        .iter()
        .find(|window| window.name == name)
        .copied()
        .ok_or_else(|| ApiError::bad_request("SQL performance window is invalid"))
}

fn create_bucket_sql(table: &str) -> String {
    let bands: String = (0..BAND_COUNT)
        .map(|index| format!(",\n  b{index} INTEGER NOT NULL"))
        .collect();
    format!(
        "CREATE TABLE IF NOT EXISTS {table} (
  bucket_start INTEGER NOT NULL,
  key TEXT NOT NULL,
  statements INTEGER NOT NULL,
  latency_sum_us INTEGER NOT NULL,
  latency_max_us INTEGER NOT NULL,
  fullscan_steps INTEGER NOT NULL{bands},
  PRIMARY KEY (bucket_start, key)
) WITHOUT ROWID;"
    )
}

/// The statement text lives once per key rather than once per bucket: a
/// statement that runs all day would otherwise write its own text into every
/// minute row it appears in.
fn create_text_sql() -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS {TEXT_TABLE} (
  key TEXT PRIMARY KEY,
  sql TEXT NOT NULL,
  caller TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS {SLOW_TABLE} (
  sampled_at INTEGER NOT NULL,
  key TEXT NOT NULL,
  latency_us INTEGER NOT NULL,
  fullscan_steps INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sql_perf_slow_at ON {SLOW_TABLE} (sampled_at DESC);"
    )
}

fn upsert_sql(table: &str) -> String {
    let columns: Vec<String> = (0..BAND_COUNT).map(|index| format!("b{index}")).collect();
    let mut values: Vec<String> = (1..=6).map(|index| format!("?{index}")).collect();
    values.extend((0..BAND_COUNT).map(|index| format!("?{}", index + 7)));
    let assignments: Vec<String> = columns
        .iter()
        .map(|column| format!("{column}={column}+excluded.{column}"))
        .collect();
    format!(
        "INSERT INTO {table} (bucket_start,key,statements,latency_sum_us,latency_max_us,fullscan_steps,{})
         VALUES ({})
         ON CONFLICT(bucket_start,key) DO UPDATE SET
           statements=statements+excluded.statements,
           latency_sum_us=latency_sum_us+excluded.latency_sum_us,
           latency_max_us=MAX(latency_max_us,excluded.latency_max_us),
           fullscan_steps=fullscan_steps+excluded.fullscan_steps,
           {}",
        columns.join(","),
        values.join(","),
        assignments.join(",")
    )
}

pub(super) struct Monitor {
    path: PathBuf,
}

impl Monitor {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(&format!(
            "{}\n{}\n{}",
            create_bucket_sql(MINUTE_TABLE),
            create_bucket_sql(HOUR_TABLE),
            create_text_sql()
        ))?;
        prune(&connection)?;
        Ok(Self {
            path: path.to_owned(),
        })
    }

    pub(super) fn persist(&self) -> Result<()> {
        notice_overhead();
        self.persist_at(now() / 60)
    }

    pub(super) fn persist_at(&self, now_minute: i64) -> Result<()> {
        let differences = differences(true);
        let slow = {
            let mut slow = slow_window().lock().unwrap_or_else(|p| p.into_inner());
            slow.drain(..).collect::<Vec<_>>()
        };
        if differences.is_empty() && slow.is_empty() {
            return Ok(());
        }
        let mut connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        let transaction = connection.transaction()?;
        {
            let mut minute = transaction.prepare_cached(&upsert_sql(MINUTE_TABLE))?;
            let mut hour = transaction.prepare_cached(&upsert_sql(HOUR_TABLE))?;
            let mut text = transaction.prepare_cached(&format!(
                "INSERT INTO {TEXT_TABLE}(key,sql,caller) VALUES(?1,?2,?3)
                 ON CONFLICT(key) DO NOTHING"
            ))?;
            for (key, counter) in &differences {
                let meta = meta()
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(key)
                    .cloned();
                if let Some(meta) = &meta {
                    text.execute(params![
                        key.to_string(),
                        meta.sql.as_ref(),
                        meta.caller.as_ref()
                    ])?;
                }
                let at = now_minute * 60;
                minute.execute(params_from_iter(values_of(at, *key, counter)))?;
                hour.execute(params_from_iter(values_of(
                    at.div_euclid(3600) * 3600,
                    *key,
                    counter,
                )))?;
            }
        }
        for sample in &slow {
            transaction.execute(
                &format!(
                    "INSERT INTO {SLOW_TABLE} (sampled_at,key,latency_us,fullscan_steps)
                     VALUES (?1,?2,?3,?4)"
                ),
                params![
                    sample.sampled_at,
                    sample.key.to_string(),
                    sample.latency_us,
                    sample.fullscan_steps,
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
                result => tracing::error!(?result, "could not persist SQL performance"),
            }
        }
    }
}

/// The recorder is a metric; if it ever costs more than a ten-thousandth of
/// wall time it has stopped being one. Says so once per crossing rather than
/// every flush, and says so again after recovering and crossing a second time.
fn notice_overhead() {
    static NOTICED: AtomicBool = AtomicBool::new(false);
    let share = overhead().share_ppm as f64;
    if share > OVERHEAD_NOTICE_PPM {
        if !NOTICED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                share_ppm = share as i64,
                "SQL profiler is costing more than a ten-thousandth of wall time"
            );
        }
    } else {
        NOTICED.store(false, Ordering::Relaxed);
    }
}

fn values_of(at: i64, key: u64, counter: &Counter) -> Vec<rusqlite::types::Value> {
    use rusqlite::types::Value;
    let mut values = vec![
        Value::Integer(at),
        Value::Text(key.to_string()),
        Value::Integer(counter.statements as i64),
        Value::Integer(counter.latency_sum_us as i64),
        Value::Integer(counter.latency_max_us as i64),
        Value::Integer(counter.fullscan_steps as i64),
    ];
    values.extend(
        counter
            .bands
            .iter()
            .map(|count| Value::Integer(*count as i64)),
    );
    values
}

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
    // A statement that fell out of the longest-lived buckets can never be
    // joined to a sample again, so its text goes with it.
    connection.execute(
        &format!("DELETE FROM {TEXT_TABLE} WHERE key NOT IN (SELECT key FROM {HOUR_TABLE})"),
        [],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct SqlPerformance {
    pub window: &'static str,
    pub resolution: &'static str,
    pub bucket_seconds: i64,
    pub generated_at: i64,
    pub latest_bucket_start: Option<i64>,
    pub enabled: bool,
    pub overhead: SqlOverhead,
    pub totals: SqlTotals,
    pub statements: Vec<SqlStatement>,
    pub series: Vec<SqlBucket>,
    pub slow: Vec<SqlSlow>,
}

#[derive(Serialize)]
pub(super) struct SqlOverhead {
    /// Every statement the callback saw, including the ones it did not time.
    pub statements: i64,
    /// Statements the recorder timed end to end, from which the cost per
    /// statement and therefore the share below are estimated.
    pub timed_statements: i64,
    pub recorder_us: i64,
    /// The recorder's own cost as parts per million of wall time: the number
    /// that has to stay near zero for this to be worth running.
    pub share_ppm: i64,
    /// Statements that found no free slot in the fixed table. A non-zero value
    /// means the table is too small for the statement mix, not that a
    /// measurement was skipped.
    pub unattributed: i64,
}

#[derive(Serialize)]
pub(super) struct SqlTotals {
    pub statements: i64,
    pub total_us: i64,
    pub fullscan_steps: i64,
    pub slow_statements: i64,
    pub average_us: Option<i64>,
    pub p50_us: Option<i64>,
    pub p95_us: Option<i64>,
    pub p99_us: Option<i64>,
    pub max_us: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct SqlStatement {
    pub key: String,
    pub sql: String,
    pub caller: String,
    pub statements: i64,
    /// The column the page sorts by: a statement that costs 18 ms every five
    /// seconds outranks a 400 ms statement nobody calls.
    pub total_us: i64,
    pub fullscan_steps: i64,
    /// Full-table steps per execution: one means a point lookup, thousands mean
    /// the statement walks more rows than it returns.
    pub fullscan_per_call: Option<i64>,
    pub slow_statements: i64,
    pub average_us: Option<i64>,
    pub p50_us: Option<i64>,
    pub p95_us: Option<i64>,
    pub p99_us: Option<i64>,
    pub max_us: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct SqlBucket {
    pub bucket_start: i64,
    pub statements: i64,
    pub total_us: i64,
    pub slow_statements: i64,
    pub fullscan_steps: i64,
    pub p95_us: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct SqlSlow {
    pub sampled_at: i64,
    pub key: String,
    pub sql: String,
    pub caller: String,
    pub latency_us: i64,
    pub fullscan_steps: i64,
}

#[derive(Clone, Default)]
struct Aggregate {
    statements: i64,
    latency_sum_us: i64,
    latency_max_us: i64,
    fullscan_steps: i64,
    bands: [i64; BAND_COUNT],
}

impl Aggregate {
    fn add(&mut self, counter: &Counter) {
        self.statements += counter.statements as i64;
        self.latency_sum_us += counter.latency_sum_us as i64;
        self.latency_max_us = self.latency_max_us.max(counter.latency_max_us as i64);
        self.fullscan_steps += counter.fullscan_steps as i64;
        for (total, count) in self.bands.iter_mut().zip(counter.bands.iter()) {
            *total += *count as i64;
        }
    }

    fn add_bands(&mut self, bands: &[i64]) {
        for (total, count) in self.bands.iter_mut().zip(bands) {
            *total += count;
        }
    }

    fn merge(&mut self, other: &Aggregate) {
        self.statements += other.statements;
        self.latency_sum_us += other.latency_sum_us;
        self.latency_max_us = self.latency_max_us.max(other.latency_max_us);
        self.fullscan_steps += other.fullscan_steps;
        self.add_bands(&other.bands);
    }
}

fn slow_count(bands: &[i64]) -> i64 {
    bands
        .iter()
        .zip(BANDS_US)
        .filter(|(_, bound)| *bound > SLOW_SAMPLE_US)
        .map(|(count, _)| count)
        .sum()
}

fn average(total_us: i64, statements: i64) -> Option<i64> {
    (statements > 0).then(|| total_us / statements)
}

fn band_columns() -> String {
    (0..BAND_COUNT)
        .map(|index| format!("SUM(b{index})"))
        .collect::<Vec<_>>()
        .join(",")
}

fn read_bands(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Vec<i64>> {
    (0..BAND_COUNT)
        .map(|index| {
            row.get::<_, Option<i64>>(offset + index)
                .map(|value| value.unwrap_or_default())
        })
        .collect()
}

fn overhead() -> SqlOverhead {
    let statements = STATEMENTS.load(Ordering::Relaxed);
    let timed = RECORDER_SAMPLED.load(Ordering::Relaxed);
    let recorder_ns = RECORDER_NS.load(Ordering::Relaxed) as i64;
    // Extrapolate the timed average over every statement, then divide by wall
    // time: both halves of the ratio cover the same span.
    let estimated_recorder_ns = match (timed, timed > 0) {
        (0, _) => 0,
        (timed, true) => recorder_ns / timed as i64 * statements as i64,
        _ => 0,
    };
    let wall_ns = STARTED
        .get()
        .map(|started| started.elapsed().as_nanos() as i64)
        .unwrap_or(0);
    SqlOverhead {
        statements: statements as i64,
        timed_statements: timed as i64,
        recorder_us: estimated_recorder_ns / 1_000,
        share_ppm: if wall_ns > 0 {
            estimated_recorder_ns.saturating_mul(1_000_000) / wall_ns
        } else {
            0
        },
        unattributed: UNATTRIBUTED.load(Ordering::Relaxed) as i64,
    }
}

impl Monitor {
    /// Answers one window from the closed buckets plus whatever the counters
    /// hold since the last flush, so the page is current instead of one flush
    /// behind.
    pub(super) fn load(&self, window: Window) -> Result<SqlPerformance, ApiError> {
        let connection =
            Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(ApiError::internal)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let since = now() - window.seconds;
        let mut statements = read_statements(&connection, window, since)?;
        let mut series = read_series(&connection, window, since)?;
        for (key, counter) in differences(false) {
            statements.entry(key.to_string()).or_default().add(&counter);
            series
                .entry(now() / window.bucket_seconds * window.bucket_seconds)
                .or_default()
                .add(&counter);
        }
        let totals = statements
            .values()
            .fold(Aggregate::default(), |mut totals, aggregate| {
                totals.merge(aggregate);
                totals
            });
        let texts = read_texts(&connection);
        let mut statements = statements
            .into_iter()
            .map(|(key, aggregate)| {
                let meta = texts.get(&key);
                SqlStatement {
                    sql: meta.map(|meta| meta.0.clone()).unwrap_or_default(),
                    caller: meta.map(|meta| meta.1.clone()).unwrap_or_default(),
                    key,
                    statements: aggregate.statements,
                    total_us: aggregate.latency_sum_us,
                    fullscan_steps: aggregate.fullscan_steps,
                    fullscan_per_call: (aggregate.statements > 0)
                        .then(|| aggregate.fullscan_steps / aggregate.statements),
                    slow_statements: slow_count(&aggregate.bands),
                    average_us: average(aggregate.latency_sum_us, aggregate.statements),
                    p50_us: percentile(
                        &aggregate.bands,
                        aggregate.statements,
                        0.50,
                        aggregate.latency_max_us,
                    ),
                    p95_us: percentile(
                        &aggregate.bands,
                        aggregate.statements,
                        0.95,
                        aggregate.latency_max_us,
                    ),
                    p99_us: percentile(
                        &aggregate.bands,
                        aggregate.statements,
                        0.99,
                        aggregate.latency_max_us,
                    ),
                    max_us: (aggregate.statements > 0).then_some(aggregate.latency_max_us),
                }
            })
            .collect::<Vec<_>>();
        statements.sort_by(|left, right| {
            right
                .total_us
                .cmp(&left.total_us)
                .then_with(|| left.key.cmp(&right.key))
        });
        let series = series
            .into_iter()
            .map(|(bucket_start, aggregate)| SqlBucket {
                bucket_start,
                statements: aggregate.statements,
                total_us: aggregate.latency_sum_us,
                slow_statements: slow_count(&aggregate.bands),
                fullscan_steps: aggregate.fullscan_steps,
                p95_us: percentile(
                    &aggregate.bands,
                    aggregate.statements,
                    0.95,
                    aggregate.latency_max_us,
                ),
            })
            .collect::<Vec<_>>();
        let latest_bucket_start = series.last().map(|bucket| bucket.bucket_start);
        let slow = merge_slow(&connection, &texts);
        Ok(SqlPerformance {
            window: window.name,
            resolution: if window.bucket_seconds < 3600 {
                "minute"
            } else {
                "hour"
            },
            bucket_seconds: window.bucket_seconds,
            generated_at: now(),
            latest_bucket_start,
            enabled: is_enabled(),
            overhead: overhead(),
            totals: SqlTotals {
                statements: totals.statements,
                total_us: totals.latency_sum_us,
                fullscan_steps: totals.fullscan_steps,
                slow_statements: slow_count(&totals.bands),
                average_us: average(totals.latency_sum_us, totals.statements),
                p50_us: percentile(
                    &totals.bands,
                    totals.statements,
                    0.50,
                    totals.latency_max_us,
                ),
                p95_us: percentile(
                    &totals.bands,
                    totals.statements,
                    0.95,
                    totals.latency_max_us,
                ),
                p99_us: percentile(
                    &totals.bands,
                    totals.statements,
                    0.99,
                    totals.latency_max_us,
                ),
                max_us: (totals.statements > 0).then_some(totals.latency_max_us),
            },
            statements,
            series,
            slow,
        })
    }
}

fn read_statements(
    connection: &Connection,
    window: Window,
    since: i64,
) -> Result<HashMap<String, Aggregate>, ApiError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT key,SUM(statements),SUM(latency_sum_us),MAX(latency_max_us),SUM(fullscan_steps),{}
             FROM {}
             WHERE bucket_start>=?1
             GROUP BY key",
            band_columns(),
            window.table
        ))
        .map_err(ApiError::internal)?;
    let rows = statement
        .query_map([since], |row| {
            let bands = read_bands(row, 5)?;
            let mut aggregate = Aggregate {
                statements: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
                latency_sum_us: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                latency_max_us: row.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                fullscan_steps: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                ..Aggregate::default()
            };
            aggregate.add_bands(&bands);
            Ok((row.get::<_, String>(0)?, aggregate))
        })
        .map_err(ApiError::internal)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ApiError::internal)?;
    Ok(rows.into_iter().collect())
}

fn read_series(
    connection: &Connection,
    window: Window,
    since: i64,
) -> Result<std::collections::BTreeMap<i64, Aggregate>, ApiError> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT bucket_start,SUM(statements),SUM(latency_sum_us),MAX(latency_max_us),SUM(fullscan_steps),{}
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
            let bands = read_bands(row, 5)?;
            let mut aggregate = Aggregate {
                statements: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
                latency_sum_us: row.get::<_, Option<i64>>(2)?.unwrap_or_default(),
                latency_max_us: row.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                fullscan_steps: row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
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
            .merge(&aggregate);
    }
    Ok(series)
}

fn read_texts(connection: &Connection) -> HashMap<String, (String, String)> {
    let mut statement =
        match connection.prepare(&format!("SELECT key,sql,caller FROM {TEXT_TABLE}")) {
            Ok(statement) => statement,
            Err(error) => {
                tracing::warn!(%error, "could not read SQL statement text");
                return HashMap::new();
            }
        };
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
            ))
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<HashMap<_, _>>>())
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not read SQL statement text");
            HashMap::new()
        })
}

fn merge_slow(connection: &Connection, texts: &HashMap<String, (String, String)>) -> Vec<SqlSlow> {
    let mut out = Vec::new();
    {
        let live = slow_window().lock().unwrap_or_else(|p| p.into_inner());
        for sample in live.iter() {
            let key = sample.key.to_string();
            let meta = texts.get(&key);
            out.push(SqlSlow {
                sampled_at: sample.sampled_at,
                key,
                sql: meta.map(|meta| meta.0.clone()).unwrap_or_default(),
                caller: meta.map(|meta| meta.1.clone()).unwrap_or_default(),
                latency_us: sample.latency_us,
                fullscan_steps: sample.fullscan_steps,
            });
        }
    }
    if let Ok(mut statement) = connection.prepare(&format!(
        "SELECT sampled_at,key,latency_us,fullscan_steps FROM {SLOW_TABLE}
         ORDER BY latency_us DESC,sampled_at DESC LIMIT ?1"
    )) {
        let rows = statement
            .query_map([SLOW_ROWS_SHOWN], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .unwrap_or_default();
        for (sampled_at, key, latency_us, fullscan_steps) in rows {
            let meta = texts.get(&key);
            out.push(SqlSlow {
                sampled_at,
                sql: meta.map(|meta| meta.0.clone()).unwrap_or_default(),
                caller: meta.map(|meta| meta.1.clone()).unwrap_or_default(),
                key,
                latency_us,
                fullscan_steps,
            });
        }
    }
    out.sort_by(|left, right| {
        right
            .latency_us
            .cmp(&left.latency_us)
            .then_with(|| right.sampled_at.cmp(&left.sampled_at))
    });
    out.truncate(SLOW_ROWS_SHOWN as usize);
    out
}
