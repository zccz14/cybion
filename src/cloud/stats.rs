//! Materialized usage-statistics snapshots.
//!
//! Request handling never scans raw history: a background patrol folds raw
//! rows into hour buckets, totals and day activity, then materializes the
//! per-range snapshot rows (`stats_view_*`) that `/api/insights` reads.
//! See `docs/usage-statistics.md` for the full architecture.

use super::*;
use futures_util::StreamExt;
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const HOUR: i64 = 3600;
/// An hour closes only after it ended and this window passed, so normally
/// settled rows fold exactly once and late settlements stay pending or go
/// through the dirty-hour queue.
const SAFETY_SECONDS: i64 = 2 * HOUR;
const PATROL_INTERVAL: Duration = Duration::from_secs(30);
const MAX_FOLD_HOURS_PER_PASS: usize = 48;
const MAX_PENDING_PER_PASS: usize = 500;
const MAX_DIRTY_HOURS_PER_PASS: usize = 24;
const MAX_PATROL_CONCURRENCY: usize = 8;
/// A database that was read keeps a raised refresh priority for this long.
const INTEREST_TTL_SECONDS: i64 = 600;
/// Views of an interested database refresh at most this often.
const INTERESTED_REFRESH_SECONDS: i64 = 120;
/// Views of a database nobody read recently refresh at most this often.
const UNINTERESTED_REFRESH_SECONDS: i64 = 600;
/// At most this many range views rebuild per database per pass.
const MAX_VIEW_RANGES_PER_PASS: usize = 2;

pub(super) const RANGES: [&str; 4] = ["24h", "7d", "30d", "all"];

const STATE_EARLIEST_HOUR: &str = "earliest_data_hour";
const STATE_CLOSED_LOW: &str = "closed_low";
const STATE_CLOSED_HIGH: &str = "closed_high";
const STATE_LATEST_RECORD: &str = "latest_record_at";

/// Marks the shared "no data at all" sentinel for `earliest_data_hour`.
const NO_DATA: i64 = -1;

fn hour_start(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(HOUR)
}

#[allow(dead_code)]
fn day_start(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(86_400)
}

fn latest_closable_hour(now_ts: i64) -> i64 {
    hour_start(now_ts - SAFETY_SECONDS - HOUR)
}

#[allow(dead_code)]
fn utc_date_string(day: i64) -> Result<String, ApiError> {
    Utc.timestamp_opt(day, 0)
        .single()
        .map(|value| value.date_naive().format("%Y-%m-%d").to_string())
        .ok_or_else(|| ApiError::internal("stats day is out of range"))
}

fn state_get(connection: &Connection, key: &str) -> Result<Option<i64>, ApiError> {
    connection
        .query_row("SELECT value FROM stats_state WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(ApiError::internal)
}

fn state_set(connection: &Connection, key: &str, value: i64) -> Result<(), ApiError> {
    connection.execute(
        "INSERT INTO stats_state(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn min_raw_timestamp(connection: &Connection) -> Result<Option<i64>, ApiError> {
    connection
        .query_row(
            "SELECT MIN(timestamp) FROM (
                 SELECT MIN(created_at) AS timestamp FROM history_records
                 UNION ALL SELECT MIN(started_at) FROM reasoning_audits
                 UNION ALL SELECT MIN(created_at) FROM worker_calls
             )",
            [],
            |row| row.get(0),
        )
        .map_err(ApiError::internal)
}

fn earliest_data_hour(connection: &Connection) -> Result<Option<i64>, ApiError> {
    // The `NO_DATA` sentinel is re-checked every pass: a database that was
    // empty when the feature first saw it must still seed its range when it
    // gains its first rows.
    let stored = state_get(connection, STATE_EARLIEST_HOUR)?;
    if let Some(value) = stored.filter(|value| *value != NO_DATA) {
        return Ok(Some(value));
    }
    let value = min_raw_timestamp(connection)?
        .map(hour_start)
        .unwrap_or(NO_DATA);
    state_set(connection, STATE_EARLIEST_HOUR, value)?;
    Ok((value != NO_DATA).then_some(value))
}

fn closed_range(connection: &Connection) -> Result<Option<(i64, i64)>, ApiError> {
    let low = state_get(connection, STATE_CLOSED_LOW)?;
    let high = state_get(connection, STATE_CLOSED_HIGH)?;
    Ok(match (low, high) {
        (Some(low), Some(high)) if low <= high => Some((low, high)),
        _ => None,
    })
}

fn record_latest(connection: &Connection, timestamp: i64) -> Result<(), ApiError> {
    let current = state_get(connection, STATE_LATEST_RECORD)?;
    if current.is_none_or(|value| timestamp > value) {
        state_set(connection, STATE_LATEST_RECORD, timestamp)?;
    }
    Ok(())
}

/// Folds one raw row set into an hour bucket, totals and day activity. The
/// caller wraps this in a transaction together with the close bookkeeping.
fn fold_hour(connection: &Connection, hour: i64) -> Result<(), ApiError> {
    let end = hour + HOUR;
    fold_hour_audits(connection, hour, end)?;
    fold_hour_workers(connection, hour, end)?;
    fold_hour_history(connection, hour, end)?;
    fold_hour_reconcile_pending(connection, hour, end)?;
    Ok(())
}

/// Rows of this hour that settled are now folded into it and no longer need
/// watching; rows that stayed unsettled keep (or re-acquire) their
/// `stats_pending` entry.
fn fold_hour_reconcile_pending(
    connection: &Connection,
    hour: i64,
    end: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "DELETE FROM stats_pending WHERE source='audit' AND row_id IN (
             SELECT CAST(id AS TEXT) FROM reasoning_audits WHERE started_at>=?1 AND started_at<?2 AND status<>'in_flight'
         )",
        params![hour, end],
    )?;
    connection.execute(
        "DELETE FROM stats_pending WHERE source='worker' AND row_id IN (
             SELECT id FROM worker_calls WHERE created_at>=?1 AND created_at<?2 AND status NOT IN ('queued','delivered')
         )",
        params![hour, end],
    )?;
    Ok(())
}

fn fold_hour_audits(connection: &Connection, hour: i64, end: i64) -> Result<(), ApiError> {
    let mut statement = connection.prepare(
        "SELECT model, COALESCE(reasoning_effort,''), request_kind, status, COUNT(*),
                COALESCE(SUM(COALESCE(input_tokens,0)),0),
                COALESCE(SUM(COALESCE(output_tokens,0)),0),
                COALESCE(SUM(COALESCE(cached_tokens,0)),0),
                COALESCE(SUM(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END),0)
         FROM reasoning_audits WHERE started_at >= ?1 AND started_at < ?2
         GROUP BY model, reasoning_effort, request_kind, status",
    )?;
    let rows = statement.query_map(params![hour, end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
        ))
    })?;
    for row in rows {
        let (model, effort, kind, status, calls, input, output, cached, duration, timed) = row?;
        connection.execute(
            "INSERT INTO stats_hour_audit(hour,model,reasoning_effort,request_kind,status,calls,input_tokens,output_tokens,cached_tokens,duration_sum,timed_calls)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(hour,model,reasoning_effort,request_kind,status) DO UPDATE SET
               calls=calls+excluded.calls, input_tokens=input_tokens+excluded.input_tokens,
               output_tokens=output_tokens+excluded.output_tokens, cached_tokens=cached_tokens+excluded.cached_tokens,
               duration_sum=duration_sum+excluded.duration_sum, timed_calls=timed_calls+excluded.timed_calls",
            params![hour, model, effort, kind, status, calls, input, output, cached, duration, timed],
        )?;
        add_total_audit(
            connection, &model, &effort, &kind, &status, calls, input, output, cached, duration,
            timed,
        )?;
    }
    let mut statement = connection.prepare(
        "SELECT id FROM reasoning_audits
         WHERE started_at >= ?1 AND started_at < ?2 AND status='in_flight'",
    )?;
    let rows = statement.query_map(params![hour, end], |row| row.get::<_, i64>(0))?;
    for row in rows {
        connection.execute(
            "INSERT OR IGNORE INTO stats_pending(source,row_id) VALUES('audit',?)",
            [row?.to_string()],
        )?;
    }
    let mut statement = connection.prepare(
        "SELECT thread_id, COUNT(*), COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0)
         FROM reasoning_audits WHERE started_at >= ?1 AND started_at < ?2 GROUP BY thread_id",
    )?;
    let rows = statement.query_map(params![hour, end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (thread_id, requests, tokens) = row?;
        add_day_activity(connection, hour, &thread_id, 0, 0, requests, tokens)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_total_audit(
    connection: &Connection,
    model: &str,
    effort: &str,
    kind: &str,
    status: &str,
    calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    duration: i64,
    timed: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "INSERT INTO stats_total_audit(model,reasoning_effort,request_kind,status,calls,input_tokens,output_tokens,cached_tokens,duration_sum,timed_calls)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(model,reasoning_effort,request_kind,status) DO UPDATE SET
           calls=calls+excluded.calls, input_tokens=input_tokens+excluded.input_tokens,
           output_tokens=output_tokens+excluded.output_tokens, cached_tokens=cached_tokens+excluded.cached_tokens,
           duration_sum=duration_sum+excluded.duration_sum, timed_calls=timed_calls+excluded.timed_calls",
        params![model, effort, kind, status, calls, input, output, cached, duration, timed],
    )?;
    Ok(())
}

fn fold_hour_workers(connection: &Connection, hour: i64, end: i64) -> Result<(), ApiError> {
    let mut statement = connection.prepare(
        "SELECT c.worker_id,
                COALESCE((SELECT a.model FROM reasoning_audits a
                          WHERE a.thread_id=c.thread_id AND a.input_record_id=c.input_record_id
                          ORDER BY a.id LIMIT 1),''),
                COALESCE((SELECT a.request_kind FROM reasoning_audits a
                          WHERE a.thread_id=c.thread_id AND a.input_record_id=c.input_record_id
                          ORDER BY a.id LIMIT 1),''),
                COUNT(*),
                COALESCE(SUM(CASE WHEN c.completed_at IS NOT NULL THEN c.completed_at - c.created_at ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN c.completed_at IS NOT NULL THEN 1 ELSE 0 END),0),
                COALESCE(SUM(length(CAST(c.arguments_json AS BLOB))),0),
                COALESCE(SUM(length(CAST(COALESCE(c.result_json,'') AS BLOB))),0),
                COALESCE(MAX(c.worker_label),'')
         FROM worker_calls c WHERE c.created_at >= ?1 AND c.created_at < ?2
         GROUP BY c.worker_id, 2, 3",
    )?;
    let rows = statement.query_map(params![hour, end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (worker_id, model, kind, calls, duration, timed, read_bytes, write_bytes, label) = row?;
        connection.execute(
            "INSERT INTO stats_hour_worker(hour,worker_id,model,request_kind,calls,duration_sum,timed_calls,read_bytes,write_bytes,label)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(hour,worker_id,model,request_kind) DO UPDATE SET
               calls=calls+excluded.calls, duration_sum=duration_sum+excluded.duration_sum,
               timed_calls=timed_calls+excluded.timed_calls, read_bytes=read_bytes+excluded.read_bytes,
               write_bytes=write_bytes+excluded.write_bytes,
               label=MAX(label,excluded.label)",
            params![hour, worker_id, model, kind, calls, duration, timed, read_bytes, write_bytes, label],
        )?;
        connection.execute(
            "INSERT INTO stats_total_worker(worker_id,model,request_kind,calls,duration_sum,timed_calls,read_bytes,write_bytes,label)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(worker_id,model,request_kind) DO UPDATE SET
               calls=calls+excluded.calls, duration_sum=duration_sum+excluded.duration_sum,
               timed_calls=timed_calls+excluded.timed_calls, read_bytes=read_bytes+excluded.read_bytes,
               write_bytes=write_bytes+excluded.write_bytes,
               label=MAX(label,excluded.label)",
            params![worker_id, model, kind, calls, duration, timed, read_bytes, write_bytes, label],
        )?;
    }
    let mut statement = connection.prepare(
        "SELECT id FROM worker_calls
         WHERE created_at >= ?1 AND created_at < ?2 AND status IN ('queued','delivered')",
    )?;
    let rows = statement.query_map(params![hour, end], |row| row.get::<_, String>(0))?;
    for row in rows {
        connection.execute(
            "INSERT OR IGNORE INTO stats_pending(source,row_id) VALUES('worker',?)",
            [row?],
        )?;
    }
    Ok(())
}

fn fold_hour_history(connection: &Connection, hour: i64, end: i64) -> Result<(), ApiError> {
    let mut statement = connection.prepare(
        "SELECT kind, COUNT(*), COALESCE(SUM(length(CAST(payload AS BLOB))),0)
         FROM history_records WHERE created_at >= ?1 AND created_at < ?2 GROUP BY kind",
    )?;
    let rows = statement.query_map(params![hour, end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (kind, records, payload_bytes) = row?;
        connection.execute(
            "INSERT INTO stats_hour_history(hour,kind,records,payload_bytes) VALUES(?1,?2,?3,?4)
             ON CONFLICT(hour,kind) DO UPDATE SET
               records=records+excluded.records, payload_bytes=payload_bytes+excluded.payload_bytes",
            params![hour, kind, records, payload_bytes],
        )?;
        connection.execute(
            "INSERT INTO stats_total_history(kind,records,payload_bytes) VALUES(?1,?2,?3)
             ON CONFLICT(kind) DO UPDATE SET
               records=records+excluded.records, payload_bytes=payload_bytes+excluded.payload_bytes",
            params![kind, records, payload_bytes],
        )?;
    }
    let mut statement = connection.prepare(
        "SELECT thread_id,
                SUM(CASE WHEN kind<>'checkpoint' THEN 1 ELSE 0 END),
                SUM(CASE WHEN kind='input' THEN 1 ELSE 0 END)
         FROM history_records WHERE created_at >= ?1 AND created_at < ?2 GROUP BY thread_id",
    )?;
    let rows = statement.query_map(params![hour, end], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        let (thread_id, records, inputs) = row?;
        add_day_activity(connection, hour, &thread_id, records, inputs, 0, 0)?;
    }
    let latest: Option<i64> = connection.query_row(
        "SELECT MAX(created_at) FROM history_records WHERE created_at >= ?1 AND created_at < ?2",
        params![hour, end],
        |row| row.get(0),
    )?;
    if let Some(latest) = latest {
        record_latest(connection, latest)?;
    }
    Ok(())
}

/// Day activity is stored as per-hour shards so a recomputed hour can correct
/// its day exactly: the hour's shards are deleted and refolded, and the day
/// aggregates are always re-derived from the shards.
fn add_day_activity(
    connection: &Connection,
    hour: i64,
    thread_id: &str,
    records: i64,
    inputs: i64,
    requests: i64,
    tokens: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "INSERT INTO stats_hour_day(hour,thread_id,records,inputs,requests,tokens) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(hour,thread_id) DO UPDATE SET
           records=records+excluded.records, inputs=inputs+excluded.inputs,
           requests=requests+excluded.requests, tokens=tokens+excluded.tokens",
        params![hour, thread_id, records, inputs, requests, tokens],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn subtract_total_audit(
    connection: &Connection,
    model: &str,
    effort: &str,
    kind: &str,
    status: &str,
    calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    duration: i64,
    timed: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "UPDATE stats_total_audit SET
           calls=calls-?5, input_tokens=input_tokens-?6, output_tokens=output_tokens-?7,
           cached_tokens=cached_tokens-?8, duration_sum=duration_sum-?9, timed_calls=timed_calls-?10
         WHERE model=?1 AND reasoning_effort=?2 AND request_kind=?3 AND status=?4",
        params![
            model, effort, kind, status, calls, input, output, cached, duration, timed
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn subtract_total_worker(
    connection: &Connection,
    worker_id: &str,
    model: &str,
    kind: &str,
    calls: i64,
    duration: i64,
    timed: i64,
    read_bytes: i64,
    write_bytes: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "UPDATE stats_total_worker SET
           calls=calls-?4, duration_sum=duration_sum-?5, timed_calls=timed_calls-?6,
           read_bytes=read_bytes-?7, write_bytes=write_bytes-?8
         WHERE worker_id=?1 AND model=?2 AND request_kind=?3",
        params![
            worker_id,
            model,
            kind,
            calls,
            duration,
            timed,
            read_bytes,
            write_bytes
        ],
    )?;
    Ok(())
}

fn subtract_total_history(
    connection: &Connection,
    kind: &str,
    records: i64,
    payload_bytes: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "UPDATE stats_total_history SET records=records-?2, payload_bytes=payload_bytes-?3 WHERE kind=?1",
        params![kind, records, payload_bytes],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Closed-range advancement
// ---------------------------------------------------------------------------

/// The earliest row timestamp inside `[from_ts, to_ts)`, rounded down to its
/// hour. Uses the per-table timestamp indexes, so it is O(log n) even when
/// the interval is empty.
fn first_row_hour(
    connection: &Connection,
    from_ts: i64,
    to_ts: i64,
) -> Result<Option<i64>, ApiError> {
    if from_ts >= to_ts {
        return Ok(None);
    }
    let earliest: Option<i64> = connection.query_row(
        "SELECT MIN(timestamp) FROM (
             SELECT MIN(created_at) AS timestamp FROM history_records WHERE created_at>=?1 AND created_at<?2
             UNION ALL SELECT MIN(started_at) FROM reasoning_audits WHERE started_at>=?1 AND started_at<?2
             UNION ALL SELECT MIN(created_at) FROM worker_calls WHERE created_at>=?1 AND created_at<?2
         )",
        params![from_ts, to_ts],
        |row| row.get(0),
    )?;
    Ok(earliest.map(hour_start))
}

/// The latest row timestamp inside `[from_ts, to_ts)`, rounded down to its hour.
fn last_row_hour(
    connection: &Connection,
    from_ts: i64,
    to_ts: i64,
) -> Result<Option<i64>, ApiError> {
    if from_ts >= to_ts {
        return Ok(None);
    }
    let latest: Option<i64> = connection.query_row(
        "SELECT MAX(timestamp) FROM (
             SELECT MAX(created_at) AS timestamp FROM history_records WHERE created_at>=?1 AND created_at<?2
             UNION ALL SELECT MAX(started_at) FROM reasoning_audits WHERE started_at>=?1 AND started_at<?2
             UNION ALL SELECT MAX(created_at) FROM worker_calls WHERE created_at>=?1 AND created_at<?2
         )",
        params![from_ts, to_ts],
        |row| row.get(0),
    )?;
    Ok(latest.map(hour_start))
}

fn range_span_hours(range: &str) -> Option<i64> {
    match range {
        "24h" => Some(24),
        "7d" => Some(168),
        "30d" => Some(720),
        // "all" (and anything unknown) is unbounded: the closed range itself.
        _ => None,
    }
}

fn range_bit(range: &str) -> i64 {
    let index = RANGES
        .iter()
        .position(|candidate| *candidate == range)
        .unwrap_or(RANGES.len() - 1);
    1 << index
}

fn range_window(low: i64, high: i64, range: &str) -> (i64, i64) {
    match range_span_hours(range) {
        Some(span) => ((high - (span - 1) * HOUR).max(low), high),
        None => (low, high),
    }
}

fn range_contains_hour(range: &str, hour: i64, low: i64, high: i64) -> bool {
    if hour < low || hour > high {
        return false;
    }
    match range_span_hours(range) {
        Some(span) => hour >= high - (span - 1) * HOUR,
        None => true,
    }
}

const STATE_VIEWS_DIRTY: &str = "views_dirty";
const STATE_VIEWS_BUILT: &str = "views_built";
const VIEW_MASK_ALL: i64 = 0b1111;

fn mark_view_mask(connection: &Connection, key: &str, mask: i64) -> Result<(), ApiError> {
    if mask == 0 {
        return Ok(());
    }
    let current = state_get(connection, key)?.unwrap_or(0);
    state_set(connection, key, current | mask)
}

fn mark_views_dirty_for_hour(connection: &Connection, hour: i64) -> Result<(), ApiError> {
    let Some((low, high)) = closed_range(connection)? else {
        return Ok(());
    };
    let mut mask = 0;
    for range in RANGES {
        if range_contains_hour(range, hour, low, high) {
            mask |= range_bit(range);
        }
    }
    mark_view_mask(connection, STATE_VIEWS_DIRTY, mask)
}

/// Ranges whose views are stale: marked dirty, or never built at all.
fn views_dirty_mask(connection: &Connection) -> Result<i64, ApiError> {
    let dirty = state_get(connection, STATE_VIEWS_DIRTY)?.unwrap_or(0);
    let built = state_get(connection, STATE_VIEWS_BUILT)?.unwrap_or(0);
    Ok((dirty | (VIEW_MASK_ALL & !built)) & VIEW_MASK_ALL)
}

/// Folds one hour into the buckets and extends the closed range beyond it, in
/// one transaction per hour: a crash never leaves folded cells without the
/// state that claims they are folded.
fn close_hour(connection: &mut Connection, hour: i64) -> Result<(), ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let already_folded =
        closed_range(&transaction)?.is_some_and(|(low, high)| hour >= low && hour <= high);
    if already_folded {
        return Ok(());
    }
    fold_hour(&transaction, hour)?;
    match closed_range(&transaction)? {
        None => {
            state_set(&transaction, STATE_CLOSED_LOW, hour)?;
            state_set(&transaction, STATE_CLOSED_HIGH, hour)?;
        }
        Some((low, high)) => {
            state_set(&transaction, STATE_CLOSED_LOW, low.min(hour))?;
            state_set(&transaction, STATE_CLOSED_HIGH, high.max(hour))?;
        }
    }
    mark_views_dirty_for_hour(&transaction, hour)?;
    transaction.commit()?;
    Ok(())
}

/// Extends the closed range over hours verified to hold no rows at all.
/// Empty hours need no cells; skipping them keeps an idle database's forward
/// edge and an old database's backfill cheap.
fn jump_closed_high(connection: &mut Connection, high: i64) -> Result<(), ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    state_set(&transaction, STATE_CLOSED_HIGH, high)?;
    // Moving the forward edge slides every window: data at the old edge may
    // have left a range.
    mark_view_mask(&transaction, STATE_VIEWS_DIRTY, VIEW_MASK_ALL)?;
    transaction.commit()?;
    Ok(())
}

fn jump_closed_low(connection: &mut Connection, low: i64) -> Result<(), ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    state_set(&transaction, STATE_CLOSED_LOW, low)?;
    // Only the all-time range's coverage claim changes; empty hours add no rows.
    mark_view_mask(&transaction, STATE_VIEWS_DIRTY, range_bit("all"))?;
    transaction.commit()?;
    Ok(())
}

/// Closes every hour that became closable and jumps the forward edge to the
/// latest closable hour when the hours in between hold no rows.
fn advance_forward(
    connection: &mut Connection,
    now_ts: i64,
    budget: &mut usize,
) -> Result<(), ApiError> {
    let latest_closable = latest_closable_hour(now_ts);
    let Some(earliest) = earliest_data_hour(connection)? else {
        return Ok(());
    };
    if latest_closable < earliest {
        // A fresh database has nothing to close until time passes the safety window.
        return Ok(());
    }
    if closed_range(connection)?.is_none() {
        if *budget == 0 {
            return Ok(());
        }
        // Seed the range at the newest closable hour; backfill proceeds downward.
        close_hour(connection, latest_closable)?;
        *budget -= 1;
    }
    loop {
        let Some((_, high)) = closed_range(connection)? else {
            return Ok(());
        };
        if high >= latest_closable {
            return Ok(());
        }
        match first_row_hour(connection, high + HOUR, latest_closable + HOUR)? {
            None => {
                jump_closed_high(connection, latest_closable)?;
                return Ok(());
            }
            Some(hour) if hour > high + HOUR => {
                jump_closed_high(connection, hour - HOUR)?;
            }
            Some(_) => {
                if *budget == 0 {
                    return Ok(());
                }
                close_hour(connection, high + HOUR)?;
                *budget -= 1;
            }
        }
    }
}

/// Extends the closed range downward toward the earliest row, newest hours
/// first, so the short ranges become exact first; hours verified empty are
/// jumped without folding.
fn advance_backfill(connection: &mut Connection, budget: &mut usize) -> Result<(), ApiError> {
    let Some(earliest) = earliest_data_hour(connection)? else {
        return Ok(());
    };
    loop {
        let Some((low, _)) = closed_range(connection)? else {
            return Ok(());
        };
        if low <= earliest {
            return Ok(());
        }
        match last_row_hour(connection, earliest, low)? {
            None => {
                jump_closed_low(connection, earliest)?;
                return Ok(());
            }
            Some(hour) if hour < low - HOUR => {
                jump_closed_low(connection, hour + HOUR)?;
            }
            Some(_) => {
                if *budget == 0 {
                    return Ok(());
                }
                close_hour(connection, low - HOUR)?;
                *budget -= 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Corrections: dirty hours and pending settlements
// ---------------------------------------------------------------------------

fn enqueue_dirty_hour(connection: &Connection, hour: i64) -> Result<(), ApiError> {
    let Some((low, high)) = closed_range(connection)? else {
        return Ok(());
    };
    if hour < low || hour > high {
        return Ok(());
    }
    connection.execute(
        "INSERT OR IGNORE INTO stats_dirty_hour(hour) VALUES(?)",
        [hour],
    )?;
    Ok(())
}

/// Notes that a raw row whose hour is already folded changed: the hour is
/// queued for recomputation. Rows whose hour is not folded yet are simply
/// picked up by the fold that closes the hour.
pub(super) fn mark_dirty(connection: &Connection, timestamp: i64) -> Result<(), ApiError> {
    enqueue_dirty_hour(connection, hour_start(timestamp))
}

/// Notes that a Thread is about to be deleted. Folded hours the Thread
/// touched are queued for recomputation (which removes its contribution from
/// cells, totals, day shards and views) and pending observations of its rows
/// are dropped. Call before the rows themselves vanish.
pub(super) fn note_thread_deleted(
    connection: &Connection,
    thread_id: &str,
) -> Result<(), ApiError> {
    connection.execute(
        "DELETE FROM stats_pending WHERE source='audit' AND row_id IN (
             SELECT CAST(id AS TEXT) FROM reasoning_audits WHERE thread_id=?
         )",
        [thread_id],
    )?;
    connection.execute(
        "DELETE FROM stats_pending WHERE source='worker' AND row_id IN (
             SELECT id FROM worker_calls WHERE thread_id=?
         )",
        [thread_id],
    )?;
    let Some((low, high)) = closed_range(connection)? else {
        return Ok(());
    };
    let mut hours = HashSet::new();
    {
        let mut statement = connection.prepare(
            "SELECT DISTINCT started_at/3600 FROM reasoning_audits
             WHERE thread_id=?1 AND started_at>=?2 AND started_at<?3",
        )?;
        let rows = statement.query_map(params![thread_id, low, high + HOUR], |row| {
            row.get::<_, i64>(0)
        })?;
        for row in rows {
            hours.insert(row? * HOUR);
        }
    }
    {
        let mut statement = connection.prepare(
            "SELECT DISTINCT created_at/3600 FROM worker_calls
             WHERE thread_id=?1 AND created_at>=?2 AND created_at<?3",
        )?;
        let rows = statement.query_map(params![thread_id, low, high + HOUR], |row| {
            row.get::<_, i64>(0)
        })?;
        for row in rows {
            hours.insert(row? * HOUR);
        }
    }
    {
        let mut statement = connection.prepare(
            "SELECT DISTINCT created_at/3600 FROM history_records
             WHERE thread_id=?1 AND created_at>=?2 AND created_at<?3",
        )?;
        let rows = statement.query_map(params![thread_id, low, high + HOUR], |row| {
            row.get::<_, i64>(0)
        })?;
        for row in rows {
            hours.insert(row? * HOUR);
        }
    }
    for hour in hours {
        connection.execute(
            "INSERT OR IGNORE INTO stats_dirty_hour(hour) VALUES(?)",
            [hour],
        )?;
    }
    Ok(())
}

/// Removes an hour's current cell values from the totals, so the hour can be
/// folded again from raw rows: totals always equal the sum of the closed
/// hours' cells.
struct AuditHourRow {
    model: String,
    effort: String,
    kind: String,
    status: String,
    calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
    duration_sum: i64,
    timed_calls: i64,
}

struct WorkerHourRow {
    worker_id: String,
    model: String,
    kind: String,
    calls: i64,
    duration_sum: i64,
    timed_calls: i64,
    read_bytes: i64,
    write_bytes: i64,
}

fn subtract_hour_from_totals(connection: &Connection, hour: i64) -> Result<(), ApiError> {
    let audits: Vec<AuditHourRow> = {
        let mut statement = connection.prepare(
            "SELECT model,reasoning_effort,request_kind,status,calls,input_tokens,output_tokens,cached_tokens,duration_sum,timed_calls
             FROM stats_hour_audit WHERE hour=?",
        )?;
        let rows = statement.query_map([hour], |row| {
            Ok(AuditHourRow {
                model: row.get(0)?,
                effort: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                calls: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                cached_tokens: row.get(7)?,
                duration_sum: row.get(8)?,
                timed_calls: row.get(9)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for row in audits {
        subtract_total_audit(
            connection,
            &row.model,
            &row.effort,
            &row.kind,
            &row.status,
            row.calls,
            row.input_tokens,
            row.output_tokens,
            row.cached_tokens,
            row.duration_sum,
            row.timed_calls,
        )?;
    }
    let workers: Vec<WorkerHourRow> = {
        let mut statement = connection.prepare(
            "SELECT worker_id,model,request_kind,calls,duration_sum,timed_calls,read_bytes,write_bytes
             FROM stats_hour_worker WHERE hour=?",
        )?;
        let rows = statement.query_map([hour], |row| {
            Ok(WorkerHourRow {
                worker_id: row.get(0)?,
                model: row.get(1)?,
                kind: row.get(2)?,
                calls: row.get(3)?,
                duration_sum: row.get(4)?,
                timed_calls: row.get(5)?,
                read_bytes: row.get(6)?,
                write_bytes: row.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for row in workers {
        subtract_total_worker(
            connection,
            &row.worker_id,
            &row.model,
            &row.kind,
            row.calls,
            row.duration_sum,
            row.timed_calls,
            row.read_bytes,
            row.write_bytes,
        )?;
    }
    let history: Vec<(String, i64, i64)> = {
        let mut statement = connection
            .prepare("SELECT kind,records,payload_bytes FROM stats_hour_history WHERE hour=?")?;
        let rows =
            statement.query_map([hour], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (kind, records, payload_bytes) in history {
        subtract_total_history(connection, &kind, records, payload_bytes)?;
    }
    Ok(())
}

/// Recomputes queued hours: an hour is subtracted from the totals, its cells
/// and day shards are dropped, and it is folded again from the raw rows. This
/// is the single correction path for late settlements, late mutations and
/// Thread deletions, so every correction lands in one additive fold.
fn recompute_dirty_hours(connection: &mut Connection, budget: usize) -> Result<usize, ApiError> {
    let hours: Vec<i64> = {
        let mut statement =
            connection.prepare("SELECT hour FROM stats_dirty_hour ORDER BY hour LIMIT ?")?;
        let rows = statement.query_map([budget as i64], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut done = 0;
    for hour in hours {
        let Some((low, high)) = closed_range(connection)? else {
            connection.execute("DELETE FROM stats_dirty_hour WHERE hour=?", [hour])?;
            continue;
        };
        if hour < low || hour > high {
            // Defensive: only folded hours can be recomputed.
            connection.execute("DELETE FROM stats_dirty_hour WHERE hour=?", [hour])?;
            continue;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        subtract_hour_from_totals(&transaction, hour)?;
        transaction.execute("DELETE FROM stats_hour_audit WHERE hour=?", [hour])?;
        transaction.execute("DELETE FROM stats_hour_worker WHERE hour=?", [hour])?;
        transaction.execute("DELETE FROM stats_hour_history WHERE hour=?", [hour])?;
        transaction.execute("DELETE FROM stats_hour_day WHERE hour=?", [hour])?;
        fold_hour(&transaction, hour)?;
        transaction.execute("DELETE FROM stats_dirty_hour WHERE hour=?", [hour])?;
        mark_views_dirty_for_hour(&transaction, hour)?;
        transaction.commit()?;
        done += 1;
    }
    Ok(done)
}

/// Watches rows that were folded while unsettled. A row that settled since is
/// removed from `stats_pending` and its hour is queued for recomputation; a
/// row that is gone needs no watching.
fn process_pending(connection: &Connection, budget: usize) -> Result<usize, ApiError> {
    let pending: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT source,row_id FROM stats_pending ORDER BY row_id,source LIMIT ?")?;
        let rows = statement.query_map([budget as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut examined = 0;
    for (source, row_id) in pending {
        examined += 1;
        let settled: Option<(i64, bool)> = match source.as_str() {
            "audit" => connection
                .query_row(
                    "SELECT started_at,status<>'in_flight' FROM reasoning_audits WHERE id=?",
                    [&row_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?,
            "worker" => connection
                .query_row(
                    "SELECT created_at,status NOT IN ('queued','delivered') FROM worker_calls WHERE id=?",
                    [&row_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?,
            _ => continue,
        };
        match settled {
            None => {
                connection.execute(
                    "DELETE FROM stats_pending WHERE source=? AND row_id=?",
                    params![&source, &row_id],
                )?;
            }
            Some((timestamp, true)) => {
                connection.execute(
                    "DELETE FROM stats_pending WHERE source=? AND row_id=?",
                    params![&source, &row_id],
                )?;
                enqueue_dirty_hour(connection, hour_start(timestamp))?;
            }
            Some((_, false)) => {}
        }
    }
    Ok(examined)
}

// ---------------------------------------------------------------------------
// Snapshot views
// ---------------------------------------------------------------------------

struct ModelCell {
    model: String,
    effort: String,
    kind: String,
    calls: i64,
    completed: i64,
    in_flight: i64,
    failed: i64,
    cancelled: i64,
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
    duration_sum: i64,
    timed_calls: i64,
}

struct WorkerCell {
    worker_id: String,
    model: String,
    kind: String,
    calls: i64,
    duration_sum: i64,
    timed_calls: i64,
    read_bytes: i64,
    write_bytes: i64,
    label: String,
}

struct DayCell {
    day: i64,
    active_threads: i64,
    records: i64,
    inputs: i64,
    requests: i64,
    tokens: i64,
}

fn model_cell_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelCell> {
    Ok(ModelCell {
        model: row.get(0)?,
        effort: row.get(1)?,
        kind: row.get(2)?,
        calls: row.get(3)?,
        completed: row.get(4)?,
        in_flight: row.get(5)?,
        failed: row.get(6)?,
        cancelled: row.get(7)?,
        input_tokens: row.get(8)?,
        output_tokens: row.get(9)?,
        cached_tokens: row.get(10)?,
        duration_sum: row.get(11)?,
        timed_calls: row.get(12)?,
    })
}

fn worker_cell_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkerCell> {
    Ok(WorkerCell {
        worker_id: row.get(0)?,
        model: row.get(1)?,
        kind: row.get(2)?,
        calls: row.get(3)?,
        duration_sum: row.get(4)?,
        timed_calls: row.get(5)?,
        read_bytes: row.get(6)?,
        write_bytes: row.get(7)?,
        label: row.get(8)?,
    })
}

fn day_cell_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DayCell> {
    Ok(DayCell {
        day: row.get::<_, i64>(0)? * 86_400,
        active_threads: row.get(1)?,
        records: row.get(2)?,
        inputs: row.get(3)?,
        requests: row.get(4)?,
        tokens: row.get(5)?,
    })
}

const MODEL_WINDOW_SQL: &str = "SELECT model,reasoning_effort,request_kind,
        COALESCE(SUM(calls),0),
        COALESCE(SUM(CASE WHEN status='completed' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='in_flight' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='failed' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='cancelled' THEN calls ELSE 0 END),0),
        COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cached_tokens),0),
        COALESCE(SUM(duration_sum),0),COALESCE(SUM(timed_calls),0)
 FROM stats_total_audit
 GROUP BY model,reasoning_effort,request_kind
 HAVING COALESCE(SUM(calls),0)+COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0)+COALESCE(SUM(cached_tokens),0)>0";

const MODEL_HOUR_SQL: &str = "SELECT model,reasoning_effort,request_kind,
        COALESCE(SUM(calls),0),
        COALESCE(SUM(CASE WHEN status='completed' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='in_flight' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='failed' THEN calls ELSE 0 END),0),
        COALESCE(SUM(CASE WHEN status='cancelled' THEN calls ELSE 0 END),0),
        COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COALESCE(SUM(cached_tokens),0),
        COALESCE(SUM(duration_sum),0),COALESCE(SUM(timed_calls),0)
 FROM stats_hour_audit WHERE hour>=?1 AND hour<=?2
 GROUP BY model,reasoning_effort,request_kind
 HAVING COALESCE(SUM(calls),0)+COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0)+COALESCE(SUM(cached_tokens),0)>0";

const WORKER_WINDOW_SQL: &str = "SELECT worker_id,model,request_kind,
        COALESCE(SUM(calls),0),COALESCE(SUM(duration_sum),0),COALESCE(SUM(timed_calls),0),
        COALESCE(SUM(read_bytes),0),COALESCE(SUM(write_bytes),0),COALESCE(MAX(label),'')
 FROM stats_total_worker
 GROUP BY worker_id,model,request_kind
 HAVING COALESCE(SUM(calls),0)+COALESCE(SUM(read_bytes),0)+COALESCE(SUM(write_bytes),0)>0";

const WORKER_HOUR_SQL: &str = "SELECT worker_id,model,request_kind,
        COALESCE(SUM(calls),0),COALESCE(SUM(duration_sum),0),COALESCE(SUM(timed_calls),0),
        COALESCE(SUM(read_bytes),0),COALESCE(SUM(write_bytes),0),COALESCE(MAX(label),'')
 FROM stats_hour_worker WHERE hour>=?1 AND hour<=?2
 GROUP BY worker_id,model,request_kind
 HAVING COALESCE(SUM(calls),0)+COALESCE(SUM(read_bytes),0)+COALESCE(SUM(write_bytes),0)>0";

const DAY_WINDOW_SQL: &str = "SELECT hour/86400,
        COUNT(DISTINCT CASE WHEN records>0 THEN thread_id END),
        COALESCE(SUM(records),0),COALESCE(SUM(inputs),0),COALESCE(SUM(requests),0),COALESCE(SUM(tokens),0)
 FROM stats_hour_day WHERE hour>=?1 AND hour<=?2
 GROUP BY hour/86400";

/// Rewrites one range's snapshot views from the folded cells and day shards.
/// The read phase runs outside the write transaction, so readers and writers
/// are only held for the short swap.
fn rebuild_range(connection: &mut Connection, range: &str, now_ts: i64) -> Result<(), ApiError> {
    let Some((low, high)) = closed_range(connection)? else {
        return Ok(());
    };
    let (start, end) = range_window(low, high, range);
    let backfilling =
        i64::from(earliest_data_hour(connection)?.is_some_and(|earliest| low > earliest));
    let latest_record_at = state_get(connection, STATE_LATEST_RECORD)?;
    let history: (i64, i64, i64) = if range == "all" {
        connection.query_row(
            "SELECT COALESCE(SUM(records),0),COALESCE(SUM(payload_bytes),0),
                    COALESCE(SUM(CASE WHEN kind='checkpoint' THEN records ELSE 0 END),0)
             FROM stats_total_history",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
    } else {
        connection.query_row(
            "SELECT COALESCE(SUM(records),0),COALESCE(SUM(payload_bytes),0),
                    COALESCE(SUM(CASE WHEN kind='checkpoint' THEN records ELSE 0 END),0)
             FROM stats_hour_history WHERE hour>=?1 AND hour<=?2",
            params![start, end],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
    };
    let models: Vec<ModelCell> = {
        let mut statement = connection.prepare(if range == "all" {
            MODEL_WINDOW_SQL
        } else {
            MODEL_HOUR_SQL
        })?;
        let rows = if range == "all" {
            statement.query_map([], model_cell_from_row)?
        } else {
            statement.query_map(params![start, end], model_cell_from_row)?
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let workers: Vec<WorkerCell> = {
        let mut statement = connection.prepare(if range == "all" {
            WORKER_WINDOW_SQL
        } else {
            WORKER_HOUR_SQL
        })?;
        let rows = if range == "all" {
            statement.query_map([], worker_cell_from_row)?
        } else {
            statement.query_map(params![start, end], worker_cell_from_row)?
        };
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let days: Vec<DayCell> = {
        let mut statement = connection.prepare(DAY_WINDOW_SQL)?;
        let rows = statement.query_map(params![start, end], day_cell_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("DELETE FROM stats_view_totals WHERE range=?", [range])?;
    transaction.execute(
        "INSERT INTO stats_view_totals(range,generated_at,backfilling,history_records,history_payload_bytes,history_checkpoints,latest_record_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![range, now_ts, backfilling, history.0, history.1, history.2, latest_record_at],
    )?;
    transaction.execute("DELETE FROM stats_view_model WHERE range=?", [range])?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO stats_view_model(range,model,reasoning_effort,request_kind,calls,completed,in_flight,failed,cancelled,input_tokens,output_tokens,cached_tokens,duration_sum,timed_calls)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        )?;
        for cell in &models {
            insert.execute(params![
                range,
                cell.model,
                cell.effort,
                cell.kind,
                cell.calls,
                cell.completed,
                cell.in_flight,
                cell.failed,
                cell.cancelled,
                cell.input_tokens,
                cell.output_tokens,
                cell.cached_tokens,
                cell.duration_sum,
                cell.timed_calls
            ])?;
        }
    }
    transaction.execute("DELETE FROM stats_view_worker WHERE range=?", [range])?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO stats_view_worker(range,worker_id,model,request_kind,calls,duration_sum,timed_calls,read_bytes,write_bytes,label)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        )?;
        for cell in &workers {
            insert.execute(params![
                range,
                cell.worker_id,
                cell.model,
                cell.kind,
                cell.calls,
                cell.duration_sum,
                cell.timed_calls,
                cell.read_bytes,
                cell.write_bytes,
                cell.label
            ])?;
        }
    }
    transaction.execute("DELETE FROM stats_view_day WHERE range=?", [range])?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO stats_view_day(range,day,active_threads,records,inputs,requests,tokens)
             VALUES(?1,?2,?3,?4,?5,?6,?7)",
        )?;
        for cell in &days {
            if cell.active_threads == 0
                && cell.records == 0
                && cell.inputs == 0
                && cell.requests == 0
                && cell.tokens == 0
            {
                continue;
            }
            insert.execute(params![
                range,
                cell.day,
                cell.active_threads,
                cell.records,
                cell.inputs,
                cell.requests,
                cell.tokens
            ])?;
        }
    }
    let bit = range_bit(range);
    let dirty = state_get(&transaction, STATE_VIEWS_DIRTY)?.unwrap_or(0) & !bit;
    state_set(&transaction, STATE_VIEWS_DIRTY, dirty)?;
    let built = state_get(&transaction, STATE_VIEWS_BUILT)?.unwrap_or(0) | bit;
    state_set(&transaction, STATE_VIEWS_BUILT, built)?;
    transaction.commit()?;
    Ok(())
}

/// Refreshes stale range views: shortest range first, at most
/// `MAX_VIEW_RANGES_PER_PASS` per pass, and each range at most once per
/// interval. Recently read databases (interest) refresh on the short interval.
fn refresh_views(
    connection: &mut Connection,
    now_ts: i64,
    interest_until: Option<i64>,
    last_refresh: &mut [i64; 4],
) -> Result<(), ApiError> {
    let dirty = views_dirty_mask(connection)?;
    if dirty == 0 {
        return Ok(());
    }
    let interested = interest_until.is_some_and(|until| until > now_ts);
    let interval = if interested {
        INTERESTED_REFRESH_SECONDS
    } else {
        UNINTERESTED_REFRESH_SECONDS
    };
    let mut refreshed = 0;
    for (index, range) in RANGES.iter().enumerate() {
        if refreshed >= MAX_VIEW_RANGES_PER_PASS {
            break;
        }
        let bit = 1i64 << index;
        if dirty & bit == 0 {
            continue;
        }
        if now_ts - last_refresh[index] < interval {
            continue;
        }
        if closed_range(connection)?.is_none() {
            break;
        }
        rebuild_range(connection, range, now_ts)?;
        last_refresh[index] = now_ts;
        refreshed += 1;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The patrol
// ---------------------------------------------------------------------------

/// Opens a database for the patrol without triggering schema migrations:
/// databases that still run an older schema are left for their next request
/// to migrate, so a deployment never migrates every database at once.
/// `Ok(None)` means "nothing to do here" — missing file, busy, or a schema
/// that is not current.
fn open_stats(path: &Path) -> Result<Option<Connection>, ApiError> {
    if !path.is_file() {
        return Ok(None);
    }
    let connection =
        match Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE) {
            Ok(connection) => connection,
            Err(_) => return Ok(None),
        };
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(ApiError::internal)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(ApiError::internal)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(ApiError::internal)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(ApiError::internal)?;
    if version != USER_SCHEMA_VERSION {
        return Ok(None);
    }
    Ok(Some(connection))
}

/// The O(1) work probe of a pass: what, if anything, this database needs.
/// Anything it misses would be a work source, so it checks them all — new
/// closable hours, backfill below the closed range, pending settlements,
/// queued corrections, and stale views.
fn database_has_work(
    connection: &Connection,
    now_ts: i64,
    interest: Option<i64>,
    last_refresh: &[i64; 4],
) -> Result<bool, ApiError> {
    let latest_closable = latest_closable_hour(now_ts);
    let closed = closed_range(connection)?;
    match closed {
        None => {
            if earliest_data_hour(connection)?.is_some_and(|earliest| earliest <= latest_closable) {
                return Ok(true);
            }
        }
        Some((low, high)) => {
            if high < latest_closable {
                return Ok(true);
            }
            if earliest_data_hour(connection)?.is_some_and(|earliest| low > earliest) {
                return Ok(true);
            }
        }
    }
    let pending: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM stats_pending)", [], |row| {
            row.get(0)
        })?;
    if pending {
        return Ok(true);
    }
    let dirty: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM stats_dirty_hour)", [], |row| {
            row.get(0)
        })?;
    if dirty {
        return Ok(true);
    }
    let dirty_views = views_dirty_mask(connection)?;
    if dirty_views == 0 || closed.is_none() {
        return Ok(false);
    }
    let interested = interest.is_some_and(|until| until > now_ts);
    let interval = if interested {
        INTERESTED_REFRESH_SECONDS
    } else {
        UNINTERESTED_REFRESH_SECONDS
    };
    for (index, _) in RANGES.iter().enumerate() {
        let bit = 1i64 << index;
        if dirty_views & bit != 0 && now_ts - last_refresh[index] >= interval {
            return Ok(true);
        }
    }
    Ok(false)
}

/// One database's slice of a pass, in priority order: fold fresh hours and
/// corrections, refresh recently read views, then backfill deeper history.
fn process_database(
    path: &Path,
    now_ts: i64,
    interest: Option<i64>,
    last_refresh: &mut [i64; 4],
) -> Result<(), ApiError> {
    let Some(mut connection) = open_stats(path)? else {
        return Ok(());
    };
    if !database_has_work(&connection, now_ts, interest, last_refresh)? {
        return Ok(());
    }
    let mut budget = MAX_FOLD_HOURS_PER_PASS;
    advance_forward(&mut connection, now_ts, &mut budget)?;
    process_pending(&connection, MAX_PENDING_PER_PASS)?;
    recompute_dirty_hours(&mut connection, MAX_DIRTY_HOURS_PER_PASS)?;
    refresh_views(&mut connection, now_ts, interest, last_refresh)?;
    advance_backfill(&mut connection, &mut budget)?;
    Ok(())
}

/// Marks recently read databases so their snapshots refresh with priority on
/// the following passes. Interest never triggers synchronous work.
pub(super) struct Patrol {
    interests: Mutex<HashMap<String, i64>>,
}

impl Patrol {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            interests: Mutex::new(HashMap::new()),
        })
    }

    pub(super) fn note_read(&self, database: &str) {
        if let Ok(mut interests) = self.interests.lock() {
            interests.insert(database.to_owned(), now() + INTEREST_TTL_SECONDS);
        }
    }

    fn interest_until(&self, database: &str, now_ts: i64) -> Option<i64> {
        let interests = self.interests.lock().ok()?;
        interests
            .get(database)
            .copied()
            .filter(|until| *until > now_ts)
    }

    fn prune(&self, now_ts: i64) {
        if let Ok(mut interests) = self.interests.lock() {
            interests.retain(|_, until| *until > now_ts);
        }
    }
}

/// The single-process background patrol. Databases without work cost only a
/// few O(1) probes per pass; all work is bounded per database per pass, and
/// nothing is ever skipped — only deferred.
pub(super) async fn supervise(state: AppState) {
    let mut last_refresh: HashMap<String, [i64; 4]> = HashMap::new();
    loop {
        if let Err(error) = patrol_pass(&state, &mut last_refresh).await {
            tracing::warn!(error=%error.message, "usage statistics patrol pass failed");
        }
        tokio::time::sleep(PATROL_INTERVAL).await;
    }
}

async fn patrol_pass(
    state: &AppState,
    last_refresh: &mut HashMap<String, [i64; 4]>,
) -> Result<(), ApiError> {
    let mut databases: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(state.data_dir.join("users")).map_err(ApiError::internal)? {
        let path = entry.map_err(ApiError::internal)?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite3") {
            continue;
        }
        let Some(database) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        databases.push((database.to_owned(), path));
    }
    databases.sort();
    let now_ts = now();
    state.stats.prune(now_ts);
    let jobs = databases
        .into_iter()
        .map(|(database, path)| {
            let interest = state.stats.interest_until(&database, now_ts);
            let mut last = last_refresh.remove(&database).unwrap_or([0; 4]);
            tokio::task::spawn_blocking(move || {
                let result = process_database(&path, now_ts, interest, &mut last);
                (database, last, result)
            })
        })
        .collect::<Vec<_>>();
    let mut pending = futures_util::stream::iter(jobs).buffer_unordered(MAX_PATROL_CONCURRENCY);
    while let Some(joined) = pending.next().await {
        match joined {
            Ok((database, last, result)) => {
                last_refresh.insert(database.clone(), last);
                if let Err(error) = result {
                    tracing::warn!(database=%database, error=%error.message, "usage statistics patrol deferred database");
                }
            }
            Err(error) => {
                tracing::warn!(error=%error, "usage statistics patrol task failed");
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 2023-11-14T22:06:40Z, hour-aligned.
    fn base_hour() -> i64 {
        1_700_000_000 - (1_700_000_000_i64).rem_euclid(HOUR)
    }

    fn open_db() -> (tempfile::TempDir, Connection) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("user.sqlite3");
        let connection = open_user(&path, true).unwrap();
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        (directory, connection)
    }

    fn insert_thread(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?1,'Fixture','m','idle',0,0)",
                [id],
            )
            .unwrap();
    }

    fn insert_history(connection: &Connection, thread_id: &str, kind: &str, created_at: i64) {
        connection
            .execute(
                "INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES(?1,?2,'{}',?3)",
                params![thread_id, kind, created_at],
            )
            .unwrap();
    }

    fn insert_audit(
        connection: &Connection,
        thread_id: &str,
        status: &str,
        started_at: i64,
        finished_at: Option<i64>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
    ) {
        connection
            .execute(
                "INSERT INTO reasoning_audits(thread_id,model,status,started_at,finished_at,input_tokens,output_tokens,cached_tokens)
                 VALUES(?1,'m',?2,?3,?4,?5,?6,0)",
                params![thread_id, status, started_at, finished_at, input_tokens, output_tokens],
            )
            .unwrap();
    }

    fn insert_worker(
        connection: &Connection,
        thread_id: &str,
        id: &str,
        status: &str,
        created_at: i64,
        completed_at: Option<i64>,
        result: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at,completed_at,result_json)
                 VALUES(?1,'w1',?2,'do','{}',?3,?4,?5,?6)",
                params![id, thread_id, status, created_at, completed_at, result],
            )
            .unwrap();
    }

    #[test]
    fn patrol_folds_recent_hours_first_and_backfills_downward() {
        let (_directory, mut connection) = open_db();
        insert_thread(&connection, "t1");
        let base = base_hour();
        let h1 = base + HOUR;
        let h2 = base + 2 * HOUR;
        let h3 = base + 3 * HOUR;
        insert_history(&connection, "t1", "input", h1 + 60);
        insert_audit(
            &connection,
            "t1",
            "completed",
            h2 + 5,
            Some(h2 + 65),
            Some(10),
            Some(20),
        );
        insert_worker(
            &connection,
            "t1",
            "c1",
            "completed",
            h3 + 10,
            Some(h3 + 40),
            Some("done"),
        );

        let now = base + 6 * HOUR;
        let mut budget = MAX_FOLD_HOURS_PER_PASS;
        advance_forward(&mut connection, now, &mut budget).unwrap();
        assert_eq!(closed_range(&connection).unwrap(), Some((h3, h3)));
        advance_backfill(&mut connection, &mut budget).unwrap();
        assert_eq!(closed_range(&connection).unwrap(), Some((h1, h3)));

        let audited: (i64, i64, i64) = connection
            .query_row(
                "SELECT COALESCE(SUM(calls),0),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0)
                 FROM stats_total_audit",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(audited, (1, 10, 20));
        let worker: (i64, i64) = connection
            .query_row(
                "SELECT COALESCE(SUM(duration_sum),0),COALESCE(SUM(timed_calls),0) FROM stats_total_worker",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(worker, (30, 1));
        let records: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(records),0) FROM stats_total_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(records, 1);

        let mut last = [0i64; 4];
        for _ in 0..3 {
            refresh_views(
                &mut connection,
                now,
                Some(now + INTEREST_TTL_SECONDS),
                &mut last,
            )
            .unwrap();
        }
        assert_eq!(views_dirty_mask(&connection).unwrap(), 0);
        let (backfilling, records): (i64, i64) = connection
            .query_row(
                "SELECT backfilling,history_records FROM stats_view_totals WHERE range='all'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((backfilling, records), (0, 1));
        let active: i64 = connection
            .query_row(
                "SELECT active_threads FROM stats_view_day WHERE range='24h' AND day=?1",
                [day_start(h1)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
        let requests: i64 = connection
            .query_row(
                "SELECT requests FROM stats_view_day WHERE range='24h' AND day=?1",
                [day_start(h2)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(requests, 1);

        // The forward edge jumps empty hours without folding them.
        let later = base + 10 * HOUR;
        advance_forward(&mut connection, later, &mut budget).unwrap();
        assert_eq!(
            closed_range(&connection).unwrap(),
            Some((h1, base + 7 * HOUR))
        );
    }

    #[test]
    fn late_settlements_recompute_their_hour_exactly() {
        let (_directory, mut connection) = open_db();
        insert_thread(&connection, "t1");
        let base = base_hour();
        let h = base + HOUR;
        insert_audit(&connection, "t1", "in_flight", h + 5, None, None, None);
        insert_worker(&connection, "t1", "c1", "queued", h + 10, None, None);

        let now = h + 3 * HOUR + 60;
        let mut budget = MAX_FOLD_HOURS_PER_PASS;
        advance_forward(&mut connection, now, &mut budget).unwrap();
        assert_eq!(closed_range(&connection).unwrap(), Some((h, h)));
        let pending: i64 = connection
            .query_row("SELECT COUNT(*) FROM stats_pending", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending, 2);

        // A result arrives for the folded call: the recomputed hour carries
        // the settled duration and output bytes exactly once.
        connection
            .execute(
                "UPDATE worker_calls SET status='completed',completed_at=?,result_json='done' WHERE id='c1'",
                [h + 40],
            )
            .unwrap();
        mark_dirty(&connection, h + 10).unwrap();
        let done = recompute_dirty_hours(&mut connection, MAX_DIRTY_HOURS_PER_PASS).unwrap();
        assert_eq!(done, 1);
        let worker: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT calls,duration_sum,timed_calls,write_bytes FROM stats_hour_worker WHERE hour=?1",
                [h],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(worker, (1, 30, 1, 4));
        let calls: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(calls),0) FROM stats_total_worker",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(calls, 1);
        let worker_pending: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM stats_pending WHERE source='worker'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(worker_pending, 0);

        // The in-flight audit settles later; the pending scan turns that into
        // a dirty hour, and recomputing moves it out of in_flight.
        connection
            .execute(
                "UPDATE reasoning_audits SET status='completed',finished_at=?,input_tokens=10,output_tokens=20 WHERE thread_id='t1'",
                [h + 80],
            )
            .unwrap();
        let examined = process_pending(&connection, MAX_PENDING_PER_PASS).unwrap();
        assert!(examined >= 1);
        let dirty: i64 = connection
            .query_row("SELECT COUNT(*) FROM stats_dirty_hour", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(dirty, 1);
        let done = recompute_dirty_hours(&mut connection, MAX_DIRTY_HOURS_PER_PASS).unwrap();
        assert_eq!(done, 1);
        let settled: (i64, i64, i64) = connection
            .query_row(
                "SELECT COALESCE(SUM(CASE WHEN status='completed' THEN calls ELSE 0 END),0),
                        COALESCE(SUM(CASE WHEN status='in_flight' THEN calls ELSE 0 END),0),
                        COALESCE(SUM(input_tokens),0)
                 FROM stats_hour_audit WHERE hour=?1",
                [h],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(settled, (1, 0, 10));
        let pending: i64 = connection
            .query_row("SELECT COUNT(*) FROM stats_pending", [], |row| row.get(0))
            .unwrap();
        assert_eq!(pending, 0);
        let calls: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(calls),0) FROM stats_total_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(calls, 1);
    }

    #[test]
    fn deleted_threads_leave_across_recomputed_hours() {
        let (_directory, mut connection) = open_db();
        insert_thread(&connection, "t1");
        insert_thread(&connection, "t2");
        let base = base_hour();
        let h1 = base + HOUR;
        let h2 = base + 2 * HOUR;
        insert_history(&connection, "t1", "input", h1 + 30);
        insert_history(&connection, "t2", "input", h1 + 45);
        insert_audit(
            &connection,
            "t1",
            "completed",
            h2 + 5,
            Some(h2 + 35),
            Some(5),
            Some(5),
        );

        let now = h2 + 3 * HOUR + 60;
        let mut budget = MAX_FOLD_HOURS_PER_PASS;
        advance_forward(&mut connection, now, &mut budget).unwrap();
        advance_backfill(&mut connection, &mut budget).unwrap();
        assert_eq!(closed_range(&connection).unwrap(), Some((h1, h2)));

        note_thread_deleted(&connection, "t1").unwrap();
        connection
            .execute("DELETE FROM history_records WHERE thread_id='t1'", [])
            .unwrap();
        connection
            .execute("DELETE FROM reasoning_audits WHERE thread_id='t1'", [])
            .unwrap();
        connection
            .execute("DELETE FROM worker_calls WHERE thread_id='t1'", [])
            .unwrap();
        connection
            .execute("DELETE FROM threads WHERE id='t1'", [])
            .unwrap();
        let done = recompute_dirty_hours(&mut connection, MAX_DIRTY_HOURS_PER_PASS).unwrap();
        assert_eq!(done, 2);
        let calls: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(calls),0) FROM stats_total_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(calls, 0);
        let records: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(records),0) FROM stats_total_history",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(records, 1);
        let shards: i64 = connection
            .query_row(
                "SELECT COALESCE(SUM(records),0) FROM stats_hour_day WHERE thread_id='t1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(shards, 0);
    }
}
