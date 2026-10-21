//! Loaded Manuals (已加载手册).
//!
//! A Manual handed over inside a tool output is message state: a compaction
//! moves the replay head past it, and a Thread that still needs the material has
//! to ask for it again. A *loaded* Manual is Thread state instead. `thread_manual_loads` holds the Thread's own decision about which
//! Manuals it keeps working from, so the decision survives both a compaction
//! and the model forgetting that it ever read them.
//!
//! The copy travels as an `activity` record the compiler replays as a developer
//! message. Records are only ever appended: the first compile after a load, the
//! first compile after an edit, and the first compile after a checkpoint each
//! append one, and every earlier request's replay prefix stays byte-identical —
//! which is what keeps the provider's prefix cache working. Nothing is rewritten
//! and nothing is removed, so a superseded copy stays visible as evidence and
//! retires with the next checkpoint instead of costing a cache reset.
//!
//! `unload_manual` deletes the row and nothing else. The copy already in the
//! conversation is deliberately left in place; the next compile appends one
//! `manual_unloaded` notice saying it is no longer maintained, and from then on
//! nothing refreshes it.

use super::*;

/// One row per Manual a Thread keeps loaded. The Thread that loads a Manual is
/// the only one that sees the binding, and the row leaves with the Thread.
pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS thread_manual_loads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  manual_id TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, manual_id)
);
"#;

/// Loaded Manuals a Thread may hold when neither the Thread nor the User set a
/// cap of their own. Every loaded Manual is delivered into each request, so the
/// cap bounds what a single request carries; a load past it is refused rather
/// than truncated.
pub(super) const DEFAULT_MAX_LOADED_MANUALS: i64 = 12;

/// The largest cap a User default or a Thread override may name. A configured
/// cap still bounds what every request of that Thread carries, so it stays
/// inside a range the conversation can afford; a value past it is refused at
/// the settings boundary, not silently clamped.
pub(super) const MAX_CONFIGURED_LOADED_MANUALS: i64 = 64;

/// Validates a cap a User default or a Thread override names.
pub(super) fn max_loaded_manuals(value: i64) -> Result<i64, ApiError> {
    if !(1..=MAX_CONFIGURED_LOADED_MANUALS).contains(&value) {
        return Err(ApiError::bad_request(format!(
            "loaded Manual cap must be between 1 and {MAX_CONFIGURED_LOADED_MANUALS}"
        )));
    }
    Ok(value)
}

/// The cap in force for one Thread: its own override, then the User default,
/// then `DEFAULT_MAX_LOADED_MANUALS`. Lowering a cap unloads nothing, so a
/// Thread can end up holding more Manuals than its cap and has to release the
/// bindings itself before it loads another.
pub(super) fn loaded_manual_cap(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection
        .query_row(
            "SELECT COALESCE(t.max_loaded_manuals, d.max_loaded_manuals, ?1)
             FROM threads t LEFT JOIN thread_defaults d ON d.id=1 WHERE t.id=?2",
            params![DEFAULT_MAX_LOADED_MANUALS, thread_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(DEFAULT_MAX_LOADED_MANUALS))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualIdArguments {
    manual_id: String,
}

/// Every Manual this Thread keeps loaded, in the order it loaded them.
pub(super) fn loaded_ids(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<String>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT manual_id FROM thread_manual_loads WHERE thread_id=? ORDER BY loaded_at,manual_id",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// The Manual as the Controller hands it to the model right now: local Manuals
/// first, then the compiled common tree in its source language. A Manual hidden
/// by the trash resolves to nothing, so a load cannot resurrect it.
fn resolve_manual(connection: &Connection, id: &str) -> Result<Option<ManualReadView>, ApiError> {
    let manual = connection
        .query_row(
            "SELECT id,name,description,content,parent_id,sort_key,trashed_at,locked FROM manuals WHERE id=?",
            [id],
            context_from_row,
        )
        .optional()?;
    if let Some(manual) = manual {
        if context_hidden(connection, id)? {
            return Ok(None);
        }
        let children = context_summaries(connection, Some(id))?;
        return Ok(Some(ManualReadView { manual, children }));
    }
    Ok(common_manuals::read(id, common_manuals::SOURCE_LANGUAGE))
}

/// The Manual JSON a loaded Thread receives: the Manual row plus its direct
/// children, minus `sort_key`, which orders a sibling list the Thread cannot see.
fn injected_context(view: &ManualReadView) -> Value {
    let mut value = serde_json::to_value(view).expect("a Manual is serializable");
    if let Some(object) = value.as_object_mut() {
        object.remove("sort_key");
    }
    value
}

/// What the replayed range already says about one Manual: the copy the Thread
/// holds, or the notice that it was released.
enum Injection {
    Loaded(String),
    Unloaded,
}

/// The newest injection event per Manual inside `[head, tail]`. A checkpoint
/// moves the head past them, which is exactly what makes the next compile
/// deliver every loaded Manual again.
fn injections(
    connection: &Connection,
    thread_id: &str,
    head: i64,
    tail: i64,
) -> Result<HashMap<String, Injection>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT payload FROM history_records
         WHERE thread_id=? AND kind='activity' AND id>=? AND id<=?
           AND json_extract(payload,'$.type') IN ('manual_loaded','manual_unloaded')
         ORDER BY id",
    )?;
    let rows = statement.query_map(params![thread_id, head, tail], |row| {
        row.get::<_, String>(0)
    })?;
    let mut newest = HashMap::new();
    for row in rows {
        let payload: Value = serde_json::from_str(&row?).map_err(ApiError::internal)?;
        let Some(manual_id) = payload.get("manual_id").and_then(Value::as_str) else {
            continue;
        };
        let injection = match payload.get("type").and_then(Value::as_str) {
            Some("manual_loaded") => Injection::Loaded(
                payload
                    .get("fingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            _ => Injection::Unloaded,
        };
        newest.insert(manual_id.to_owned(), injection);
    }
    Ok(newest)
}

/// Brings the range that is about to replay in line with the Thread's bindings,
/// appending only what it does not already say. Returns the newest appended
/// record, or `None` when the range was already current — the common case, and
/// the one that keeps a request byte-identical to the one before it.
pub(super) fn append_injections(
    connection: &Connection,
    thread_id: &str,
    tail: i64,
) -> Result<Option<i64>, ApiError> {
    let loaded = loaded_ids(connection, thread_id)?;
    let head = context_idx_head(connection, thread_id, tail)?;
    let known = injections(connection, thread_id, head, tail)?;
    let bound = loaded.iter().map(String::as_str).collect::<HashSet<_>>();
    // Bound Manuals in load order first, then whatever the range still carries
    // a copy of but this Thread no longer holds.
    let mut pending = loaded.clone();
    let mut released = known
        .keys()
        .filter(|id| !bound.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    released.sort();
    pending.extend(released);
    let mut newest = None;
    for manual_id in pending {
        let holds = bound.contains(manual_id.as_str());
        let current = resolve_manual(connection, &manual_id)?;
        // A Manual that stops resolving — deleted, or hidden by the trash —
        // releases itself, so the Thread is told once instead of every attempt.
        let missing = current.is_none() && holds;
        if missing {
            connection.execute(
                "DELETE FROM thread_manual_loads WHERE thread_id=? AND manual_id=?",
                params![thread_id, &manual_id],
            )?;
        }
        let payload = match (current, holds) {
            (Some(view), true) => {
                let fingerprint = context_fingerprint(
                    &view.manual.name,
                    &view.manual.description,
                    &view.manual.content,
                );
                if matches!(known.get(&manual_id), Some(Injection::Loaded(known)) if *known == fingerprint)
                {
                    continue;
                }
                json!({
                    "type": "manual_loaded",
                    "manual_id": manual_id,
                    "fingerprint": fingerprint,
                    "manual": injected_context(&view),
                })
            }
            // The copy in the conversation stops being maintained, so say so
            // once: the notice itself keeps the next compile from repeating it.
            (_, _) if !matches!(known.get(&manual_id), Some(Injection::Loaded(_))) => continue,
            _ => json!({
                "type": "manual_unloaded",
                "manual_id": manual_id,
                "reason": if missing { "missing" } else { "released" },
            }),
        };
        newest = Some(persist_history_record(
            connection,
            HistoryRecordInsert {
                thread_id,
                kind: "activity",
                payload: &payload,
                created_at: now(),
            },
        )?);
    }
    Ok(newest)
}

/// A `manual_loaded` or `manual_unloaded` activity replays as the developer
/// message it stands for.
pub(super) fn notice_message(payload: &Value) -> Option<Value> {
    let manual_id = payload.get("manual_id").and_then(Value::as_str)?;
    match payload.get("type").and_then(Value::as_str)? {
        "manual_loaded" => {
            let manual = serde_json::to_string_pretty(payload.get("manual")?).ok()?;
            Some(json!({
                "role": "developer",
                "content": format!(
                    "Manual {manual_id} is loaded in this Thread and this is its current content. The controller maintains this copy: when the Manual changes, or when a compaction replaces this history, a newer copy is delivered after this one without any tool call. Treat it as authoritative over any earlier copy of the same Manual in this conversation, and never ask for it again to stay current.\n\n```json\n{manual}\n```\n\nCall unload_manual with this manual_id once this Thread no longer needs it."
                ),
            }))
        }
        "manual_unloaded" => {
            let why = match payload.get("reason").and_then(Value::as_str) {
                Some("missing") => "It can no longer be read, so this Thread released it.",
                _ => "This Thread released it, so the copy is no longer maintained.",
            };
            Some(json!({
                "role": "developer",
                "content": format!(
                    "Manual {manual_id} is no longer loaded in this Thread. {why} Do not rely on any copy of it in this conversation, and call load_manual with this manual_id if the Thread needs it current again."
                ),
            }))
        }
        _ => None,
    }
}

pub(super) async fn load_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments: ManualIdArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!(
            "load_manual arguments must contain an explicit manual_id: {error}"
        ))
    })?;
    let id = manual_id(&arguments.manual_id)?;
    let thread = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        if resolve_manual(connection, &id)?.is_none() {
            return Ok(json!({ "error": "manual not found" }));
        }
        let loaded_at: Option<i64> = connection
            .query_row(
                "SELECT loaded_at FROM thread_manual_loads WHERE thread_id=? AND manual_id=?",
                params![thread, id],
                |row| row.get(0),
            )
            .optional()?;
        if loaded_at.is_none() {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM thread_manual_loads WHERE thread_id=?",
                [&thread],
                |row| row.get(0),
            )?;
            let cap = loaded_manual_cap(connection, &thread)?;
            if count >= cap {
                return Ok(json!({
                    "error": format!(
                        "this Thread holds {count} loaded Manuals and its cap is {cap}; call unload_manual on one this Thread no longer needs first"
                    ),
                }));
            }
            connection.execute(
                "INSERT INTO thread_manual_loads(thread_id,manual_id,loaded_at) VALUES(?,?,?)",
                params![thread, id, now()],
            )?;
        }
        Ok(json!({
            "manual_id": id,
            "loaded": true,
            "already_loaded": loaded_at.is_some(),
            "note": "From now on the controller maintains this Manual for this Thread: its JSON arrives in the next developer message and is refreshed by itself when the Manual changes or a compaction replaces the history. Nothing needs to be asked for again to keep it current.",
        }))
    })
    .await
}

pub(super) async fn unload_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments: ManualIdArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!(
            "unload_manual arguments must contain an explicit manual_id: {error}"
        ))
    })?;
    let id = manual_id(&arguments.manual_id)?;
    let thread = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        let released = connection.execute(
            "DELETE FROM thread_manual_loads WHERE thread_id=? AND manual_id=?",
            params![thread, id],
        )? > 0;
        Ok(json!({
            "manual_id": id,
            "unloaded": released,
            "note": if released {
                "The copy already in this conversation stays until the next compaction; it is no longer refreshed, and a notice after this answer says it must not be relied on."
            } else {
                "This Manual was not loaded in this Thread; nothing changed."
            },
        }))
    })
    .await
}
