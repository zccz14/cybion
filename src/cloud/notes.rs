//! Sticky notes (便签).
//!
//! A note is a short, user-owned item attached to exactly one Thread: the Thread
//! that wrote it is the only one that sees it and the only one that crosses it
//! out. The durable state is two columns by design: a note is open while
//! `done_at` is NULL, and crossing it out only stamps the time. Text never
//! changes after creation and the model has no delete, so "finished" and "gone"
//! can never be confused.
//!
//! The open cap bounds the block injected into every inference request, so
//! request assembly never truncates: a Thread sees its own open notes, and
//! nothing else.

use super::*;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
"#;

/// Open notes one Thread may carry. The cap bounds the injected block; an add
/// past it is refused instead of truncated.
pub(super) const MAX_OPEN_THREAD: i64 = 10;
/// Prompt-scale default: a note may lean on its Thread's manual, because no
/// other Thread ever reads it. System configuration overrides it.
pub(super) const DEFAULT_THREAD_MAX_CHARS: i64 = 120;
pub(super) const MAX_CHARS_CEILING: i64 = 2000;
/// Crossed-out notes stay as evidence; the page shows the most recent ones.
const DONE_HISTORY: i64 = 100;
pub(super) const THREAD_MAX_CHARS_KEY: &str = "notes.thread_max_chars";
/// COMPATIBILITY: releases before global notes were removed stored a second,
/// larger character limit under this key. The page prunes it while it reads the
/// limit that remains, so no deployment keeps a setting nothing reads. Retire
/// the prune once every deployment has opened the notes settings; keep the
/// retirement test.
const RETIRED_GLOBAL_MAX_CHARS_KEY: &str = "notes.global_max_chars";
const INJECTION_HEADER: &str = "Sticky notes";
const INJECTION_RULES: &str = "Cross out what you finished. A note is visible and crossable only in the Thread that wrote it. Ask the user when you are blocked.";

#[derive(Debug, Serialize)]
pub(super) struct NoteView {
    pub id: String,
    pub thread_id: String,
    pub thread_title: Option<String>,
    pub text: String,
    pub created_at: i64,
    pub done_at: Option<i64>,
}

#[derive(Debug, Default, Serialize)]
pub(super) struct CrossOutOutcome {
    pub crossed_out: Vec<String>,
    pub already_done: Vec<String>,
    pub not_found: Vec<String>,
}

/// Who is crossing a note out. A Thread may only cross its own notes; the owner
/// (browser) may cross anything they own.
pub(super) enum CrossOutAuthority<'a> {
    Thread(&'a str),
    Owner,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddNotesArguments {
    items: Vec<AddNoteItem>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddNoteItem {
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CrossOutNotesArguments {
    note_ids: Vec<String>,
}

#[derive(Serialize)]
pub(super) struct NotesView {
    open: Vec<NoteView>,
    done: Vec<NoteView>,
}

#[derive(Serialize)]
pub(super) struct NoteSettingsView {
    thread_max_chars: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateNoteSettingsInput {
    thread_max_chars: Option<i64>,
}

fn note_view_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteView> {
    Ok(NoteView {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        thread_title: row.get(2)?,
        text: row.get(3)?,
        created_at: row.get(4)?,
        done_at: row.get(5)?,
    })
}

const SELECT_NOTES: &str = "SELECT n.id,n.thread_id,t.title,n.text,n.created_at,n.done_at \
     FROM notes n LEFT JOIN threads t ON t.id=n.thread_id";

/// Eight hex characters: short enough to sit in every injected line, wide
/// enough that a collision inside one user's notes is regenerated on insert.
fn note_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_owned()
}

pub(super) fn list(connection: &Connection) -> Result<(Vec<NoteView>, Vec<NoteView>), ApiError> {
    let mut open_statement = connection.prepare(&format!(
        "{SELECT_NOTES} WHERE n.done_at IS NULL ORDER BY n.created_at,n.id"
    ))?;
    let open = open_statement
        .query_map([], note_view_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut done_statement = connection.prepare(&format!(
        "{SELECT_NOTES} WHERE n.done_at IS NOT NULL ORDER BY n.done_at DESC,n.id DESC LIMIT {DONE_HISTORY}"
    ))?;
    let done = done_statement
        .query_map([], note_view_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok((open, done))
}

pub(super) fn load(connection: &Connection, id: &str) -> Result<Option<NoteView>, ApiError> {
    Ok(connection
        .query_row(
            &format!("{SELECT_NOTES} WHERE n.id=?"),
            [id],
            note_view_from_row,
        )
        .optional()?)
}

fn open_thread_count(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM notes WHERE done_at IS NULL AND thread_id=?",
        [thread_id],
        |row| row.get(0),
    )?)
}

fn insert_note(
    connection: &Connection,
    thread_id: &str,
    text: &str,
) -> Result<(String, i64), ApiError> {
    let created_at = now();
    for _ in 0..4 {
        let id = note_id();
        let changed = connection.execute(
            "INSERT INTO notes(id,thread_id,text,created_at) VALUES(?,?,?,?)
             ON CONFLICT(id) DO NOTHING",
            params![&id, thread_id, text, created_at],
        )?;
        if changed == 1 {
            return Ok((id, created_at));
        }
    }
    Err(ApiError::internal("could not allocate a unique note id"))
}

/// Adds notes to one Thread. Validation runs before anything is written, so a
/// rejected batch leaves the notes untouched and the model can retry with
/// shorter text against the same state.
pub(super) fn add(
    connection: &mut Connection,
    thread_id: &str,
    texts: &[String],
    limit: i64,
) -> Result<(Vec<NoteView>, i64), ApiError> {
    let mut cleaned = Vec::with_capacity(texts.len());
    for text in texts {
        let text = text.trim();
        if text.is_empty() {
            return Err(ApiError::bad_request("note text must not be empty"));
        }
        let characters = text.chars().count() as i64;
        if characters > limit {
            return Err(ApiError::bad_request(format!(
                "note is {characters} characters; a note allows at most {limit}. \
                 Condense it into one short line and call add_notes again."
            )));
        }
        cleaned.push(text.to_owned());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let open = open_thread_count(&transaction, thread_id)?;
    if open + cleaned.len() as i64 > MAX_OPEN_THREAD {
        return Err(ApiError::bad_request(format!(
            "this Thread already holds {open} open notes; the limit is {MAX_OPEN_THREAD}. \
             Cross out what is finished, or ask the user to tear off the notes that no longer apply."
        )));
    }
    let mut added = Vec::with_capacity(cleaned.len());
    for text in cleaned {
        let (id, created_at) = insert_note(&transaction, thread_id, &text)?;
        added.push(NoteView {
            id,
            thread_id: thread_id.to_owned(),
            thread_title: None,
            text,
            created_at,
            done_at: None,
        });
    }
    let open = open_thread_count(&transaction, thread_id)?;
    transaction.commit()?;
    Ok((added, open))
}

/// Crossing out is the only state change a note has. An already-crossed note is
/// reported instead of failing, and a note the caller cannot see is reported as
/// missing rather than forbidden: another Thread's notes are not part of this
/// Thread's world.
pub(super) fn cross_out(
    connection: &mut Connection,
    authority: CrossOutAuthority<'_>,
    ids: &[String],
) -> Result<CrossOutOutcome, ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut outcome = CrossOutOutcome::default();
    for id in ids {
        let row: Option<(String, Option<i64>)> = transaction
            .query_row(
                "SELECT thread_id,done_at FROM notes WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((owner, done_at)) = row else {
            outcome.not_found.push(id.clone());
            continue;
        };
        let visible = match authority {
            CrossOutAuthority::Owner => true,
            CrossOutAuthority::Thread(current) => owner == current,
        };
        if !visible {
            outcome.not_found.push(id.clone());
            continue;
        }
        if done_at.is_some() {
            outcome.already_done.push(id.clone());
            continue;
        }
        transaction.execute(
            "UPDATE notes SET done_at=? WHERE id=? AND done_at IS NULL",
            params![now(), id],
        )?;
        outcome.crossed_out.push(id.clone());
    }
    transaction.commit()?;
    Ok(outcome)
}

pub(super) fn tear(connection: &Connection, id: &str) -> Result<bool, ApiError> {
    Ok(connection.execute("DELETE FROM notes WHERE id=?", [id])? == 1)
}

/// A Thread's notes live and die with it: the note was written against that
/// Thread's manual, so it has no meaning once the Thread is gone. The delete
/// confirmation lists what goes.
pub(super) fn tear_thread(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.execute("DELETE FROM notes WHERE thread_id=?", [thread_id])? as i64)
}

/// The model-facing block injected before every inference request: the open
/// notes of this Thread. No compaction or title request carries it, and a
/// Thread with nothing open gets no block at all.
pub(super) fn injection_block(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<String>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT id,text FROM notes WHERE done_at IS NULL AND thread_id=? ORDER BY created_at,id",
    )?;
    let notes = statement
        .query_map([thread_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if notes.is_empty() {
        return Ok(None);
    }
    let mut block = format!("{INJECTION_HEADER} ({}):\n", notes.len());
    for (id, text) in notes {
        block.push_str(&format!("[{id}] {text}\n"));
    }
    block.push_str(INJECTION_RULES);
    Ok(Some(block))
}

/// Places the block immediately before the newest user input, so the request
/// tail is the user's actual message and the replayed prefix stays stable.
pub(super) fn inject(items: &mut Vec<Value>, block: &str) {
    let item = json!({"role":"developer","content":block});
    match items
        .iter()
        .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
    {
        Some(index) => items.insert(index, item),
        None => items.push(item),
    }
}

async fn thread_max_chars(state: &AppState) -> Result<i64, ApiError> {
    let path = state.admin_db_path.clone();
    tokio::task::spawn_blocking(move || {
        admin_meta_int_sync(&path, THREAD_MAX_CHARS_KEY, DEFAULT_THREAD_MAX_CHARS)
    })
    .await
    .map_err(ApiError::internal)?
}

pub(super) async fn add_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments: AddNotesArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("add_notes arguments are invalid: {error}"))
    })?;
    if arguments.items.is_empty() {
        return Err(ApiError::bad_request(
            "add_notes requires at least one item",
        ));
    }
    let limit = thread_max_chars(state).await?;
    let thread = thread_id.to_owned();
    let texts = arguments
        .items
        .into_iter()
        .map(|item| item.text)
        .collect::<Vec<_>>();
    let (added, open) = user_db(state, user, true, move |connection| {
        add(connection, &thread, &texts, limit)
    })
    .await?;
    Ok(json!({
        "added": added
            .iter()
            .map(|note| json!({"note_id": note.id, "text": note.text}))
            .collect::<Vec<_>>(),
        "open": open,
    }))
}

pub(super) async fn cross_out_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments: CrossOutNotesArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("cross_out_notes arguments are invalid: {error}"))
    })?;
    if arguments.note_ids.is_empty() {
        return Err(ApiError::bad_request(
            "cross_out_notes requires at least one note id",
        ));
    }
    let ids = arguments.note_ids;
    let thread = thread_id.to_owned();
    let outcome = user_db(state, user, true, move |connection| {
        cross_out(connection, CrossOutAuthority::Thread(&thread), &ids)
    })
    .await?;
    serde_json::to_value(outcome).map_err(ApiError::internal)
}

pub(super) async fn list_notes(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<NotesView>, ApiError> {
    let (open, done) = user_db(&state, &identity.user, true, |connection| list(connection)).await?;
    Ok(Json(NotesView { open, done }))
}

fn note_id_argument(value: &str) -> Result<String, ApiError> {
    if value.len() == 8 && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(ApiError::not_found("note not found"))
    }
}

/// The owner crosses a note out from the notes page; the Thread rule does not
/// apply to the person who wrote the note.
pub(super) async fn cross_out_note(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<NoteView>, ApiError> {
    let id = note_id_argument(&id)?;
    let note = user_db(&state, &identity.user, true, move |connection| {
        if load(connection, &id)?.is_none() {
            return Err(ApiError::not_found("note not found"));
        }
        cross_out(
            connection,
            CrossOutAuthority::Owner,
            std::slice::from_ref(&id),
        )?;
        load(connection, &id)
    })
    .await?
    .ok_or_else(|| ApiError::not_found("note not found"))?;
    Ok(Json(note))
}

pub(super) async fn delete_note(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let id = note_id_argument(&id)?;
    let removed = user_db(&state, &identity.user, true, move |connection| {
        tear(connection, &id)
    })
    .await?;
    if !removed {
        return Err(ApiError::not_found("note not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn settings(
    State(state): State<AppState>,
) -> Result<Json<NoteSettingsView>, ApiError> {
    let path = state.admin_db_path.clone();
    let thread_max_chars = tokio::task::spawn_blocking(move || {
        prune_admin_meta_sync(&path, RETIRED_GLOBAL_MAX_CHARS_KEY)?;
        admin_meta_int_sync(&path, THREAD_MAX_CHARS_KEY, DEFAULT_THREAD_MAX_CHARS)
    })
    .await
    .map_err(ApiError::internal)??;
    Ok(Json(NoteSettingsView { thread_max_chars }))
}

pub(super) async fn update_settings(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<UpdateNoteSettingsInput>,
) -> Result<Json<NoteSettingsView>, ApiError> {
    if !is_admin(&state, &identity.user.id, false).await? {
        return Err(ApiError::forbidden("administrator access is required"));
    }
    if let Some(value) = input.thread_max_chars
        && !(1..=MAX_CHARS_CEILING).contains(&value)
    {
        return Err(ApiError::bad_request(format!(
            "note character limit must be between 1 and {MAX_CHARS_CEILING}"
        )));
    }
    let path = state.admin_db_path.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(value) = input.thread_max_chars {
            set_admin_meta_int_sync(&path, THREAD_MAX_CHARS_KEY, value)?;
        }
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(ApiError::internal)??;
    settings(State(state)).await
}
