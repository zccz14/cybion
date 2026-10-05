//! Materialized usage-statistics snapshots.
//!
//! Request handling never scans raw history: a background patrol folds raw
//! rows into hour buckets, totals and day activity, then materializes the
//! per-range snapshot rows (`stats_view_*`) that `/api/insights` reads.
//! See `docs/usage-statistics.md` for the full architecture.

use super::*;
use rusqlite::{OptionalExtension, params_from_iter, types::Value};
use std::collections::{BTreeMap, HashMap, HashSet};
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

fn day_start(timestamp: i64) -> i64 {
    timestamp - timestamp.rem_euclid(86_400)
}

fn latest_closable_hour(now_ts: i64) -> i64 {
    hour_start(now_ts - SAFETY_SECONDS - HOUR)
}

fn utc_date_string(day: i64) -> Result<String, ApiError> {
    Utc.timestamp_opt(day, 0)
        .single()
        .map(|value| value.date_naive().format("%Y-%m-%d").to_string())
        .ok_or_else(|| ApiError::internal("stats day is out of range"))
}

fn state_get(connection: &Connection, key: &str) -> Result<Option<i64>, ApiError> {
    connection
        .query_row(
            "SELECT value FROM stats_state WHERE key=?",
            [key],
            |row| row.get(0),
        )
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

fn earliest_data_hour(connection: &Connection) -> Result<Option<i64>, ApiError> {
    let stored = state_get(connection, STATE_EARLIEST_HOUR)?;
    if let Some(value) = stored {
        return Ok((value != NO_DATA).then_some(value));
    }
    let earliest: Option<i64> = connection.query_row(
        "SELECT MIN(timestamp) FROM (
             SELECT MIN(created_at) AS timestamp FROM history_records
             UNION ALL SELECT MIN(started_at) FROM reasoning_audits
             UNION ALL SELECT MIN(created_at) FROM worker_calls
         )",
        [],
        |row| row.get(0),
    )?;
    let value = earliest.map(hour_start).unwrap_or(NO_DATA);
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
            connection, &model, &effort, &kind, &status, calls, input, output, cached, duration, timed,
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
            [row?],
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
        add_day_activity(connection, day_start(hour), &thread_id, 0, 0, requests, tokens)?;
    }
    Ok(())
}

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
    let rows = statement.query_map(params![hour, end], |row| row.get::<_, i64>(0))?;
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
        add_day_activity(connection, day_start(hour), &thread_id, records, inputs, 0, 0)?;
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

fn add_day_activity(
    connection: &Connection,
    day: i64,
    thread_id: &str,
    records: i64,
    inputs: i64,
    requests: i64,
    tokens: i64,
) -> Result<(), ApiError> {
    connection.execute(
        "INSERT INTO stats_day(day,thread_id,records,inputs,requests,tokens) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(day,thread_id) DO UPDATE SET
           records=records+excluded.records, inputs=inputs+excluded.inputs,
           requests=requests+excluded.requests, tokens=tokens+excluded.tokens",
        params![day, thread_id, records, inputs, requests, tokens],
    )?;
    Ok(())
}

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
        params![model, effort, kind, status, calls, input, output, cached, duration, timed],
    )?;
    Ok(())
}

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
        params![worker_id, model, kind, calls, duration, timed, read_bytes, write_bytes],
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
