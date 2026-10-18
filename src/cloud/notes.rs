//! Sticky notes (便签).
//!
//! A note is a short, user-owned item with one of two scopes: global
//! (`thread_id` is NULL, visible to every Thread) or attached to exactly one
//! Thread (visible and crossable only there). The durable state is two columns
//! by design: a note is open while `done_at` is NULL, and crossing it out only
//! stamps the time. Text never changes after creation and the model has no
//! delete, so "finished" and "gone" can never be confused.
//!
//! The two open caps bound the block injected into every inference request, so
//! request assembly never truncates: a Thread sees its own open notes plus the
//! open global notes, and nothing else.

use super::*;

pub(super) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
"#;

/// Open notes one Thread may carry, and open global notes its injection shares
/// with every other Thread. Together they bound the injected block; an add past
/// the cap is refused instead of truncated.
pub(super) const MAX_OPEN_THREAD: i64 = 10;
pub(super) const MAX_OPEN_GLOBAL: i64 = 10;
/// Prompt-scale defaults: a thread note may lean on its Thread's context, a
/// global note must read on its own. System configuration overrides both.
pub(super) const DEFAULT_THREAD_MAX_CHARS: i64 = 120;
pub(super) const DEFAULT_GLOBAL_MAX_CHARS: i64 = 200;
pub(super) const MAX_CHARS_CEILING: i64 = 2000;
/// Crossed-out notes stay as evidence; the page shows the most recent ones.
const DONE_HISTORY: i64 = 100;
const THREAD_MAX_CHARS_KEY: &str = "notes.thread_max_chars";
const GLOBAL_MAX_CHARS_KEY: &str = "notes.global_max_chars";
const INJECTION_HEADER: &str = "Sticky notes";
const INJECTION_RULES: &str = "Cross out what you finished. Global notes are shared with every thread; a note attached to this thread is visible and crossable only here. Ask the user when you are blocked.";

#[derive(Debug, Serialize)]
pub(super) struct NoteView {
    pub id: String,
    pub thread_id: Option<String>,
    pub thread_title: Option<String>,
    pub text: String,
    pub created_at: i64,
    pub done_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub(super) struct OpenCounts {
    pub thread: i64,
    pub global: i64,
}

#[derive(Debug, Default, Serialize)]
pub(super) struct CrossOutOutcome {
    pub crossed_out: Vec<String>,
    pub already_done: Vec<String>,
    pub not_found: Vec<String>,
}

/// Who is crossing a note out. A Thread may only cross its own notes plus the
/// global ones; the owner (browser or API key) may cross anything they own.
pub(super) enum CrossOutAuthority<'a> {
    Thread(&'a str),
    Owner,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum NoteScope {
    Thread,
    Global,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddNotesArguments {
    scope: Option<NoteScope>,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateNoteInput {
    text: String,
}

#[derive(Serialize)]
pub(super) struct NotesView {
    open: Vec<NoteView>,
    done: Vec<NoteView>,
}

#[derive(Serialize)]
pub(super) struct NoteSettingsView {
    thread_max_chars: i64,
    global_max_chars: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateNoteSettingsInput {
    thread_max_chars: Option<i64>,
    global_max_chars: Option<i64>,
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
        "{SELECT_NOTES} WHERE n.done_at IS NULL ORDER BY n.thread_id IS NOT NULL,n.created_at,n.id"
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

fn open_counts(connection: &Connection, thread_id: &str) -> Result<OpenCounts, ApiError> {
    Ok(OpenCounts {
        thread: connection.query_row(
            "SELECT COUNT(*) FROM notes WHERE done_at IS NULL AND thread_id=?",
            [thread_id],
            |row| row.get(0),
        )?,
        global: connection.query_row(
            "SELECT COUNT(*) FROM notes WHERE done_at IS NULL AND thread_id IS NULL",
            [],
            |row| row.get(0),
        )?,
    })
}

fn insert_note(
    connection: &Connection,
    thread_id: Option<&str>,
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

/// Adds notes for one scope. Validation runs before anything is written, so a
/// rejected batch leaves the notes untouched and the model can retry with
/// shorter text against the same state.
pub(super) fn add(
    connection: &mut Connection,
    thread_id: Option<&str>,
    texts: &[String],
    limit: i64,
) -> Result<(Vec<NoteView>, OpenCounts), ApiError> {
    let scope = if thread_id.is_some() {
        "thread"
    } else {
        "global"
    };
    let cap = if thread_id.is_some() {
        MAX_OPEN_THREAD
    } else {
        MAX_OPEN_GLOBAL
    };
    let mut cleaned = Vec::with_capacity(texts.len());
    for text in texts {
        let text = text.trim();
        if text.is_empty() {
            return Err(ApiError::bad_request("note text must not be empty"));
        }
        let characters = text.chars().count() as i64;
        if characters > limit {
            return Err(ApiError::bad_request(format!(
                "note is {characters} characters; {scope} notes allow at most {limit}. \
                 Condense it into one short line and call add_notes again."
            )));
        }
        cleaned.push(text.to_owned());
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let open: i64 = match thread_id {
        Some(id) => transaction.query_row(
            "SELECT COUNT(*) FROM notes WHERE done_at IS NULL AND thread_id=?",
            [id],
            |row| row.get(0),
        )?,
        None => transaction.query_row(
            "SELECT COUNT(*) FROM notes WHERE done_at IS NULL AND thread_id IS NULL",
            [],
            |row| row.get(0),
        )?,
    };
    if open + cleaned.len() as i64 > cap {
        return Err(ApiError::bad_request(format!(
            "{scope} notes already hold {open} open items; the limit is {cap}. \
             Cross out what is finished, or ask the user to tear off the notes that no longer apply."
        )));
    }
    let mut added = Vec::with_capacity(cleaned.len());
    for text in cleaned {
        let (id, created_at) = insert_note(&transaction, thread_id, &text)?;
        added.push(NoteView {
            id,
            thread_id: thread_id.map(str::to_owned),
            thread_title: None,
            text,
            created_at,
            done_at: None,
        });
    }
    let counts = open_counts(&transaction, thread_id.unwrap_or_default())?;
    transaction.commit()?;
    Ok((added, counts))
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
        let row: Option<(Option<String>, Option<i64>)> = transaction
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
            CrossOutAuthority::Thread(current) => {
                owner.as_deref().is_none_or(|owner| owner == current)
            }
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
/// Thread's context, so promoting it to global would only manufacture a note
/// nobody downstream can read. The delete confirmation lists what goes.
pub(super) fn tear_thread(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.execute("DELETE FROM notes WHERE thread_id=?", [thread_id])? as i64)
}

/// The model-facing block injected before every inference request: open global
/// notes, then the open notes of this Thread. No compaction or title request
/// carries it, and a Thread with nothing open gets no block at all.
pub(super) fn injection_block(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<String>, ApiError> {
    let mut statement = connection.prepare(
        "SELECT id,thread_id,text FROM notes WHERE done_at IS NULL \
         AND (thread_id IS NULL OR thread_id=?) \
         ORDER BY thread_id IS NOT NULL,created_at,id",
    )?;
    let rows = statement.query_map([thread_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut global = Vec::new();
    let mut attached = Vec::new();
    for row in rows {
        let (id, owner, text) = row?;
        if owner.is_none() {
            global.push((id, text));
        } else {
            attached.push((id, text));
        }
    }
    if global.is_empty() && attached.is_empty() {
        return Ok(None);
    }
    let mut block = String::new();
    for (heading, notes) in [("global", &global), ("this thread", &attached)] {
        if notes.is_empty() {
            continue;
        }
        block.push_str(&format!(
            "{INJECTION_HEADER} — {heading} ({}):\n",
            notes.len()
        ));
        for (id, text) in notes {
            block.push_str(&format!("[{id}] {text}\n"));
        }
    }
    block.push_str(INJECTION_RULES);
    Ok(Some(block))
}

/// Appends the block to the very end of the request.
///
/// The notes are the only part of the prompt that changes from turn to turn, so
/// they must be last: prefix caching matches from the first item, and a block
/// placed before the newest user input would diverge exactly there, making the
/// provider re-process everything the previous turn sent after it — its user
/// message, its tool calls and their outputs. At the tail only the block itself
/// is re-read, both across turns and after a note changes mid-turn. The codebase
/// already ends requests with synthetic instructions (checkpoint and title
/// generation), so a trailing developer message is an established shape.
pub(super) fn inject(items: &mut Vec<Value>, block: &str) {
    items.push(json!({"role":"developer","content":block}));
}

async fn limits(state: &AppState) -> Result<(i64, i64), ApiError> {
    let path = state.admin_db_path.clone();
    tokio::task::spawn_blocking(move || {
        Ok::<_, ApiError>((
            admin_meta_int_sync(&path, THREAD_MAX_CHARS_KEY, DEFAULT_THREAD_MAX_CHARS)?,
            admin_meta_int_sync(&path, GLOBAL_MAX_CHARS_KEY, DEFAULT_GLOBAL_MAX_CHARS)?,
        ))
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
    let scope = arguments.scope.unwrap_or(NoteScope::Thread);
    let (thread_max_chars, global_max_chars) = limits(state).await?;
    let (limit, owner) = match scope {
        NoteScope::Thread => (thread_max_chars, Some(thread_id.to_owned())),
        NoteScope::Global => (global_max_chars, None),
    };
    let texts = arguments
        .items
        .into_iter()
        .map(|item| item.text)
        .collect::<Vec<_>>();
    let (added, counts) = user_db(state, user, true, move |connection| {
        add(connection, owner.as_deref(), &texts, limit)
    })
    .await?;
    Ok(json!({
        "scope": match scope { NoteScope::Thread => "thread", NoteScope::Global => "global" },
        "added": added
            .iter()
            .map(|note| json!({"note_id": note.id, "text": note.text}))
            .collect::<Vec<_>>(),
        "open": counts,
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

pub(super) async fn create_note(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<CreateNoteInput>,
) -> Result<Json<NoteView>, ApiError> {
    let (_, global_max_chars) = limits(&state).await?;
    let text = input.text;
    let note = user_db(&state, &identity.user, true, move |connection| {
        let (added, _) = add(
            connection,
            None,
            std::slice::from_ref(&text),
            global_max_chars,
        )?;
        Ok(added.into_iter().next())
    })
    .await?
    .ok_or_else(|| ApiError::internal("note was not stored"))?;
    Ok(Json(note))
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
    let (thread_max_chars, global_max_chars) = limits(&state).await?;
    Ok(Json(NoteSettingsView {
        thread_max_chars,
        global_max_chars,
    }))
}

pub(super) async fn update_settings(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Json(input): Json<UpdateNoteSettingsInput>,
) -> Result<Json<NoteSettingsView>, ApiError> {
    if !is_admin(&state, &identity.user.id, false).await? {
        return Err(ApiError::forbidden("administrator access is required"));
    }
    for value in [input.thread_max_chars, input.global_max_chars]
        .into_iter()
        .flatten()
    {
        if !(1..=MAX_CHARS_CEILING).contains(&value) {
            return Err(ApiError::bad_request(format!(
                "note character limits must be between 1 and {MAX_CHARS_CEILING}"
            )));
        }
    }
    let path = state.admin_db_path.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(value) = input.thread_max_chars {
            set_admin_meta_int_sync(&path, THREAD_MAX_CHARS_KEY, value)?;
        }
        if let Some(value) = input.global_max_chars {
            set_admin_meta_int_sync(&path, GLOBAL_MAX_CHARS_KEY, value)?;
        }
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(ApiError::internal)??;
    settings(State(state)).await
}
