use super::tests::{create_test_thread, test_state};
use super::*;

fn notes_connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut connection).unwrap();
    connection
}

fn insert_thread(connection: &Connection, id: &str, title: &str) {
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,?,?,'idle',?,?)",
            params![id, title, "model", now(), now()],
        )
        .unwrap();
}

fn texts(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn page_texts(connection: &Connection) -> Vec<(String, String)> {
    let (open, _) = notes::list(connection).unwrap();
    let mut listed = open
        .iter()
        .map(|note| (note.thread_id.clone(), note.text.clone()))
        .collect::<Vec<_>>();
    listed.sort();
    listed
}

#[test]
fn user_schema_creates_the_notes_table() {
    let connection = notes_connection();
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='notes')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(exists);
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    // A note belongs to exactly one Thread; the column cannot be left NULL, which
    // is what would represent a note shared by every Thread.
    let not_null: i64 = connection
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('notes') WHERE name='thread_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(not_null, 1);
}

#[test]
fn add_trims_text_and_refuses_a_long_note_without_writing_anything() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, open) = notes::add(
        &mut connection,
        "thread-a",
        &texts(&["  pay the November rent  "]),
        120,
    )
    .unwrap();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].text, "pay the November rent");
    assert_eq!(added[0].thread_id, "thread-a");
    assert_eq!(open, 1);

    let long = "x".repeat(121);
    let error = notes::add(&mut connection, "thread-a", &[long], 120).unwrap_err();
    assert!(
        error.message.contains("121 characters"),
        "{}",
        error.message
    );
    assert!(error.message.contains("at most 120"), "{}", error.message);
    assert!(error.message.contains("Condense"), "{}", error.message);
    // A refused batch leaves the notes exactly as they were.
    let (open, _) = notes::list(&connection).unwrap();
    assert_eq!(open.len(), 1);

    let error = notes::add(&mut connection, "thread-a", &[String::new()], 200).unwrap_err();
    assert!(
        error.message.contains("must not be empty"),
        "{}",
        error.message
    );
}

#[test]
fn a_thread_holds_at_most_ten_open_notes() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    for index in 0..notes::MAX_OPEN_THREAD {
        notes::add(
            &mut connection,
            "thread-a",
            &[format!("thread item {index}")],
            120,
        )
        .unwrap();
    }
    let error =
        notes::add(&mut connection, "thread-a", &texts(&["one too many"]), 120).unwrap_err();
    assert!(error.message.contains("limit is 10"), "{}", error.message);
    // Another Thread has its own allowance; the cap is per Thread, not per user.
    let (_, open) = notes::add(&mut connection, "thread-b", &texts(&["b item"]), 120).unwrap();
    assert_eq!(open, 1);
    assert_eq!(
        page_texts(&connection).len(),
        1 + notes::MAX_OPEN_THREAD as usize
    );
}

#[test]
fn cross_out_respects_thread_visibility_and_is_idempotent() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    let (thread_note, _) =
        notes::add(&mut connection, "thread-a", &texts(&["thread debt"]), 120).unwrap();
    let thread_ids = vec![thread_note[0].id.clone()];

    // Another Thread cannot see or cross it, and learns nothing about it.
    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-b"),
        &thread_ids,
    )
    .unwrap();
    assert_eq!(outcome.not_found, thread_ids);
    assert!(outcome.crossed_out.is_empty());

    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-a"),
        &thread_ids,
    )
    .unwrap();
    assert_eq!(outcome.crossed_out, thread_ids);
    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-a"),
        &thread_ids,
    )
    .unwrap();
    assert_eq!(outcome.already_done, thread_ids);

    // The owner crosses a note out from the notes page regardless of the Thread.
    let (other, _) =
        notes::add(&mut connection, "thread-b", &texts(&["another debt"]), 120).unwrap();
    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Owner,
        &[other[0].id.clone()],
    )
    .unwrap();
    assert_eq!(outcome.crossed_out.len(), 1);
}

#[test]
fn injection_shows_this_threads_open_notes_only() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    assert!(
        notes::injection_block(&connection, "thread-a")
            .unwrap()
            .is_none()
    );
    notes::add(&mut connection, "thread-a", &texts(&["alpha item"]), 120).unwrap();
    notes::add(&mut connection, "thread-b", &texts(&["beta item"]), 120).unwrap();
    let block = notes::injection_block(&connection, "thread-a")
        .unwrap()
        .unwrap();
    assert!(block.contains("Sticky notes (1):"), "{block}");
    assert!(block.contains("alpha item"), "{block}");
    assert!(!block.contains("beta item"), "{block}");
    let other = notes::injection_block(&connection, "thread-b")
        .unwrap()
        .unwrap();
    assert!(other.contains("beta item"), "{other}");
    assert!(!other.contains("alpha item"), "{other}");
}

#[test]
fn injection_skips_crossed_notes_entirely() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, _) =
        notes::add(&mut connection, "thread-a", &texts(&["finished item"]), 120).unwrap();
    notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-a"),
        &[added[0].id.clone()],
    )
    .unwrap();
    assert!(
        notes::injection_block(&connection, "thread-a")
            .unwrap()
            .is_none()
    );
}

#[test]
fn the_injected_block_precedes_the_newest_user_input() {
    let mut items = vec![
        json!({"role":"user","content":"first"}),
        json!({"role":"assistant","content":"reply"}),
        json!({"role":"user","content":"second"}),
    ];
    notes::inject(&mut items, "block");
    assert_eq!(items.len(), 4);
    assert_eq!(items[2], json!({"role":"developer","content":"block"}));
    assert_eq!(items[3], json!({"role":"user","content":"second"}));

    let mut empty: Vec<Value> = Vec::new();
    notes::inject(&mut empty, "block");
    assert_eq!(empty, vec![json!({"role":"developer","content":"block"})]);
}

#[test]
fn deleting_a_thread_tears_off_only_its_notes() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    notes::add(
        &mut connection,
        "thread-a",
        &texts(&["a one", "a two"]),
        120,
    )
    .unwrap();
    notes::add(&mut connection, "thread-b", &texts(&["b one"]), 120).unwrap();

    assert_eq!(notes::tear_thread(&connection, "thread-a").unwrap(), 2);
    assert_eq!(
        page_texts(&connection),
        vec![("thread-b".to_owned(), "b one".to_owned())]
    );
}

#[test]
fn the_notes_page_reads_open_then_crossed_notes_with_their_thread_title() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, _) = notes::add(
        &mut connection,
        "thread-a",
        &texts(&["keep me open", "cross me out"]),
        120,
    )
    .unwrap();
    notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-a"),
        &[added[1].id.clone()],
    )
    .unwrap();
    let (open, done) = notes::list(&connection).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].text, "keep me open");
    assert_eq!(open[0].thread_title.as_deref(), Some("Thread A"));
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].text, "cross me out");
    assert!(done[0].done_at.is_some());
}

#[test]
fn the_owner_tears_a_note_off_for_good() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, _) = notes::add(&mut connection, "thread-a", &texts(&["mistake"]), 120).unwrap();
    assert!(notes::tear(&connection, &added[0].id).unwrap());
    assert!(notes::load(&connection, &added[0].id).unwrap().is_none());
    assert!(!notes::tear(&connection, &added[0].id).unwrap());
}

#[test]
fn note_character_limits_default_and_override_as_system_configuration() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("default.sqlite3");
    assert_eq!(
        admin_meta_int_sync(&path, "notes.thread_max_chars", 120).unwrap(),
        120
    );
    set_admin_meta_int_sync(&path, "notes.thread_max_chars", 64).unwrap();
    assert_eq!(
        admin_meta_int_sync(&path, "notes.thread_max_chars", 120).unwrap(),
        64
    );
    // A damaged value falls back to the deployment default rather than failing.
    set_admin_meta_int_sync(&path, "notes.thread_max_chars", 64).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE app_meta SET value='not a number' WHERE key='notes.thread_max_chars'",
            [],
        )
        .unwrap();
    assert_eq!(
        admin_meta_int_sync(&path, "notes.thread_max_chars", 120).unwrap(),
        120
    );
}

#[test]
fn the_retired_global_limit_is_pruned_from_system_configuration() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("retired.sqlite3");
    set_admin_meta_int_sync(&path, "notes.thread_max_chars", 90).unwrap();
    set_admin_meta_int_sync(&path, "notes.global_max_chars", 200).unwrap();
    prune_admin_meta_sync(&path, "notes.global_max_chars").unwrap();
    let connection = Connection::open(&path).unwrap();
    let retired: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM app_meta WHERE key='notes.global_max_chars'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retired, 0);
    // The limit that remains is untouched, so the prune cannot eat live settings.
    assert_eq!(
        admin_meta_int_sync(&path, "notes.thread_max_chars", 120).unwrap(),
        90
    );
}

#[test]
fn the_schema_upgrade_drops_global_notes_and_requires_a_thread() {
    let mut connection = Connection::open_in_memory().unwrap();
    // Freeze the deployed schema-43 shape: `thread_id` was nullable, and NULL was
    // how a note became global.
    connection
        .execute_batch(
            "CREATE TABLE notes (
               id TEXT PRIMARY KEY,
               thread_id TEXT,
               text TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               done_at INTEGER
             );
             INSERT INTO notes(id,thread_id,text,created_at) VALUES
               ('aaaaaaaa',NULL,'global debt',1),
               ('bbbbbbbb','thread-a','thread debt',2),
               ('cccccccc',NULL,'crossed global debt',3);
             UPDATE notes SET done_at=4 WHERE id='cccccccc';",
        )
        .unwrap();
    connection.pragma_update(None, "user_version", 43).unwrap();

    ensure_user_schema(&mut connection).unwrap();

    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    let kept: Vec<(String, String)> = connection
        .prepare("SELECT id,text FROM notes ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        kept,
        vec![("bbbbbbbb".to_owned(), "thread debt".to_owned())]
    );
    let not_null: i64 = connection
        .query_row(
            "SELECT \"notnull\" FROM pragma_table_info('notes') WHERE name='thread_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(not_null, 1);
    // The mode the product removed can no longer be written at all.
    assert!(
        connection
            .execute(
                "INSERT INTO notes(id,thread_id,text,created_at) VALUES('dddddddd',NULL,'global again',5)",
                [],
            )
            .is_err()
    );
}

#[tokio::test]
async fn the_add_notes_tool_attaches_to_the_calling_thread_and_takes_no_scope() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "notes-tool-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let output = notes::add_tool_output(
        &state,
        &user,
        &thread_id,
        r#"{"items":[{"text":"pay the rent"}]}"#,
    )
    .await
    .unwrap();
    assert_eq!(output["open"], json!(1));
    assert_eq!(output["added"][0]["text"], json!("pay the rent"));
    assert!(output.get("scope").is_none(), "{output}");
    // The controller stamps the calling Thread, so the note cannot land anywhere
    // else and there is no field left that could ask it to.
    let stored: Vec<String> = user_db(&state, &user, false, |connection| {
        let mut statement = connection.prepare("SELECT thread_id FROM notes")?;
        Ok(statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<String>, _>>()?)
    })
    .await
    .unwrap();
    assert_eq!(stored, vec![thread_id.clone()]);

    let error = notes::add_tool_output(
        &state,
        &user,
        &thread_id,
        r#"{"scope":"global","items":[{"text":"everywhere"}]}"#,
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("scope"), "{}", error.message);
    let open: i64 = user_db(&state, &user, false, |connection| {
        Ok(connection.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?)
    })
    .await
    .unwrap();
    assert_eq!(open, 1, "a refused call writes nothing");
}
