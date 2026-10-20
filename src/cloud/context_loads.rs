//! Loaded Contexts (已加载上下文).
//!
//! `read_context` hands a Context over inside a tool output, which is message
//! state: a compaction moves the replay head past it, and a Thread that still
//! needs the material has to read it again. A *loaded* Context is Thread state
//! instead. `thread_context_loads` holds the Thread's own decision about which
//! Contexts it keeps working from, so the decision survives both a compaction
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
//! `unload_context` deletes the row and nothing else. The copy already in the
//! conversation is deliberately left in place; the next compile appends one
//! `context_unloaded` notice saying it is no longer maintained, and from then on
//! nothing refreshes it.

use super::*;

/// One row per Context a Thread keeps loaded. The Thread that loads a Context is
/// the only one that sees the binding, and the row leaves with the Thread.
pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS thread_context_loads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, context_id)
);
"#;

/// Loaded Contexts one Thread may hold. Every one of them is delivered into each
/// request, so the cap bounds what a single request carries; a load past it is
/// refused rather than truncated.
pub(super) const MAX_LOADED_THREAD: i64 = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextIdArguments {
    context_id: String,
}

/// Every Context this Thread keeps loaded, in the order it loaded them.
pub(super) fn loaded_ids(
    connection: &Connection,
    thread_id: &str,
) -> Result<Vec<String>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT context_id FROM thread_context_loads WHERE thread_id=? ORDER BY loaded_at,context_id",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

/// The Context as `read_context` would hand it over right now: local Contexts
/// first, then the compiled common tree in its source language. A Context hidden
/// by the trash resolves to nothing, exactly as it does for the tool.
fn resolve_context(connection: &Connection, id: &str) -> Result<Option<ContextReadView>, ApiError> {
    let context = connection
        .query_row(
            "SELECT id,name,description,content,parent_id,sort_key,trashed_at,locked FROM contexts WHERE id=?",
            [id],
            context_from_row,
        )
        .optional()?;
    if let Some(context) = context {
        if context_hidden(connection, id)? {
            return Ok(None);
        }
        let children = context_summaries(connection, Some(id))?;
        return Ok(Some(ContextReadView { context, children }));
    }
    Ok(common_contexts::read(id, common_contexts::SOURCE_LANGUAGE))
}

/// The Context JSON a loaded Thread receives. It matches a `read_context` answer
/// except for `sort_key`, which orders a sibling list the Thread cannot see.
fn injected_context(view: &ContextReadView) -> Value {
    let mut value = serde_json::to_value(view).expect("a Context is serializable");
    if let Some(object) = value.as_object_mut() {
        object.remove("sort_key");
    }
    value
}

/// What the replayed range already says about one Context: the copy the Thread
/// holds, or the notice that it was released.
enum Injection {
    Loaded(String),
    Unloaded,
}

/// The newest injection event per Context inside `[head, tail]`. A checkpoint
/// moves the head past them, which is exactly what makes the next compile
/// deliver every loaded Context again.
fn injections(
    connection: &Connection,
    thread_id: &str,
    head: i64,
    tail: i64,
) -> Result<HashMap<String, Injection>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT payload FROM history_records
         WHERE thread_id=? AND kind='activity' AND id>=? AND id<=?
           AND json_extract(payload,'$.type') IN ('context_loaded','context_unloaded')
         ORDER BY id",
    )?;
    let rows = statement.query_map(params![thread_id, head, tail], |row| {
        row.get::<_, String>(0)
    })?;
    let mut newest = HashMap::new();
    for row in rows {
        let payload: Value = serde_json::from_str(&row?).map_err(ApiError::internal)?;
        let Some(context_id) = payload.get("context_id").and_then(Value::as_str) else {
            continue;
        };
        let injection = match payload.get("type").and_then(Value::as_str) {
            Some("context_loaded") => Injection::Loaded(
                payload
                    .get("fingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
            _ => Injection::Unloaded,
        };
        newest.insert(context_id.to_owned(), injection);
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
    // Bound Contexts in load order first, then whatever the range still carries
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
    for context_id in pending {
        let holds = bound.contains(context_id.as_str());
        let current = resolve_context(connection, &context_id)?;
        // A Context that stops resolving — deleted, or hidden by the trash —
        // releases itself, so the Thread is told once instead of every attempt.
        let missing = current.is_none() && holds;
        if missing {
            connection.execute(
                "DELETE FROM thread_context_loads WHERE thread_id=? AND context_id=?",
                params![thread_id, &context_id],
            )?;
        }
        let payload = match (current, holds) {
            (Some(view), true) => {
                let fingerprint = context_fingerprint(
                    &view.context.name,
                    &view.context.description,
                    &view.context.content,
                );
                if matches!(known.get(&context_id), Some(Injection::Loaded(known)) if *known == fingerprint)
                {
                    continue;
                }
                json!({
                    "type": "context_loaded",
                    "context_id": context_id,
                    "fingerprint": fingerprint,
                    "context": injected_context(&view),
                })
            }
            // The copy in the conversation stops being maintained, so say so
            // once: the notice itself keeps the next compile from repeating it.
            (_, _) if !matches!(known.get(&context_id), Some(Injection::Loaded(_))) => continue,
            _ => json!({
                "type": "context_unloaded",
                "context_id": context_id,
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

/// A `context_loaded` or `context_unloaded` activity replays as the developer
/// message it stands for.
pub(super) fn notice_message(payload: &Value) -> Option<Value> {
    let context_id = payload.get("context_id").and_then(Value::as_str)?;
    match payload.get("type").and_then(Value::as_str)? {
        "context_loaded" => {
            let context = serde_json::to_string_pretty(payload.get("context")?).ok()?;
            Some(json!({
                "role": "developer",
                "content": format!(
                    "Context {context_id} is loaded in this Thread and this is its current content. The controller maintains this copy: when the Context changes, or when a compaction replaces this history, a newer copy is delivered after this one without any tool call. Treat it as authoritative over any earlier copy of the same Context in this conversation, and never call read_context to refresh it.\n\n```json\n{context}\n```\n\nCall unload_context with this context_id once this Thread no longer needs it."
                ),
            }))
        }
        "context_unloaded" => {
            let why = match payload.get("reason").and_then(Value::as_str) {
                Some("missing") => "It can no longer be read, so this Thread released it.",
                _ => "This Thread released it, so the copy is no longer maintained.",
            };
            Some(json!({
                "role": "developer",
                "content": format!(
                    "Context {context_id} is no longer loaded in this Thread. {why} Do not rely on any copy of it in this conversation, and call load_context with this context_id if the Thread needs it current again."
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
    let arguments: ContextIdArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!(
            "load_context arguments must contain an explicit context_id: {error}"
        ))
    })?;
    let id = context_id(&arguments.context_id)?;
    let thread = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        if resolve_context(connection, &id)?.is_none() {
            return Ok(json!({ "error": "context not found" }));
        }
        let loaded_at: Option<i64> = connection
            .query_row(
                "SELECT loaded_at FROM thread_context_loads WHERE thread_id=? AND context_id=?",
                params![thread, id],
                |row| row.get(0),
            )
            .optional()?;
        if loaded_at.is_none() {
            let count: i64 = connection.query_row(
                "SELECT COUNT(*) FROM thread_context_loads WHERE thread_id=?",
                [&thread],
                |row| row.get(0),
            )?;
            if count >= MAX_LOADED_THREAD {
                return Ok(json!({
                    "error": format!(
                        "this Thread already holds {MAX_LOADED_THREAD} loaded Contexts; call unload_context on one this Thread no longer needs first"
                    ),
                }));
            }
            connection.execute(
                "INSERT INTO thread_context_loads(thread_id,context_id,loaded_at) VALUES(?,?,?)",
                params![thread, id, now()],
            )?;
        }
        Ok(json!({
            "context_id": id,
            "loaded": true,
            "already_loaded": loaded_at.is_some(),
            "note": "From now on the controller maintains this Context for this Thread: its JSON arrives in the next developer message and is refreshed by itself when the Context changes or a compaction replaces the history. Do not call read_context to keep it current.",
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
    let arguments: ContextIdArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!(
            "unload_context arguments must contain an explicit context_id: {error}"
        ))
    })?;
    let id = context_id(&arguments.context_id)?;
    let thread = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        let released = connection.execute(
            "DELETE FROM thread_context_loads WHERE thread_id=? AND context_id=?",
            params![thread, id],
        )? > 0;
        Ok(json!({
            "context_id": id,
            "unloaded": released,
            "note": if released {
                "The copy already in this conversation stays until the next compaction; it is no longer refreshed, and a notice after this answer says it must not be relied on."
            } else {
                "This Context was not loaded in this Thread; nothing changed."
            },
        }))
    })
    .await
}
