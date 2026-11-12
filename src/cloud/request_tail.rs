//! The request tail.
//!
//! Every inference request carries one item that is not part of the
//! conversation itself: the Thread's own bookkeeping — the notes it still owes,
//! and whatever else the model must know about this request. That item is
//! frozen as an `activity` record *before* the request compiles, inside the same
//! transaction, so the compiled request stays a pure function of its record
//! range: the compiler reads records and nothing else, and replaying the same
//! range twice produces the same items.
//!
//! INVARIANT: one tail record is written per inference attempt, and only the
//! record named by `idx_tail` replays. A tail left behind by a failed attempt
//! stays in history as evidence and never reaches the model, because the newer
//! freeze supersedes it.
//!
//! The record carries the rendered text, not the inputs it was rendered from:
//! the bytes the model read stay recoverable across renderer changes, the same
//! way a `manual_loaded` record carries its copy.

use super::*;

/// `history_records.kind` stays `activity`; the payload names the type, as
/// `manual_loaded` and `context` records do.
pub(super) const TYPE: &str = "request_tail";

fn is_tail(kind: &str, payload: &str) -> bool {
    if kind != "activity" {
        return false;
    }
    serde_json::from_str::<Value>(payload)
        .ok()
        .is_some_and(|payload| matches!(payload.get("type").and_then(Value::as_str), Some(TYPE)))
}

/// The tail record this range ends at, when it ends at one. Never an earlier
/// tail: the newest freeze supersedes every older one.
pub(super) fn at(
    connection: &Connection,
    thread_id: &str,
    idx_tail: i64,
) -> Result<Option<(i64, i64, String, String)>, ApiError> {
    let row = connection
        .query_row(
            "SELECT id,created_at,kind,payload FROM history_records WHERE id=? AND thread_id=?",
            params![idx_tail, thread_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    Ok(row.filter(|(_, _, kind, payload)| is_tail(kind, payload)))
}

/// Freezes this request's tail and returns the record id, or nothing when the
/// Thread has nothing to report: a record that would replay no item is not
/// worth a row, and the range then ends at its last conversation record.
///
/// Called inside the transaction that compiles the request, after the Manual
/// copies, so the tail is the last record of the range the model reads.
pub(super) fn append(connection: &Connection, thread_id: &str) -> Result<Option<i64>, ApiError> {
    let Some(text) = notes::injection_block(connection, thread_id)? else {
        return Ok(None);
    };
    let payload = json!({ "type": TYPE, "text": text });
    let id = persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id,
            kind: "activity",
            payload: &payload,
            created_at: now(),
        },
    )?;
    Ok(Some(id))
}

/// Whether a tail record replays at all. A tail with nothing to say — no open
/// notes yet, and nothing else to report — is still written, so every request
/// ends at one, but it stays out of the model context and out of its estimate.
pub(super) fn replays(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|payload| {
            payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|text| !text.is_empty())
}

/// A tail record replays as the developer message it froze: the folded card in
/// the conversation is the same text the model reads. A tail with nothing to say
/// writes no item.
pub(super) fn message(payload: &Value) -> Option<Value> {
    if payload.get("type").and_then(Value::as_str)? != TYPE {
        return None;
    }
    let content = payload.get("text").and_then(Value::as_str)?;
    if content.is_empty() {
        return None;
    }
    Some(json!({ "role": "developer", "content": content }))
}
