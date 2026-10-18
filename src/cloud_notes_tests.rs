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
}

#[test]
fn add_trims_text_and_refuses_a_long_note_without_writing_anything() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, counts) = notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["  pay the November rent  "]),
        120,
    )
    .unwrap();
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].text, "pay the November rent");
    assert_eq!(counts.thread, 1);

    let long = "x".repeat(121);
    let error = notes::add(&mut connection, Some("thread-a"), &[long], 120).unwrap_err();
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

    let error = notes::add(&mut connection, None, &[String::new()], 200).unwrap_err();
    assert!(
        error.message.contains("must not be empty"),
        "{}",
        error.message
    );
}

#[test]
fn each_scope_has_its_own_open_limit() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    for index in 0..notes::MAX_OPEN_THREAD {
        notes::add(
            &mut connection,
            Some("thread-a"),
            &[format!("thread item {index}")],
            120,
        )
        .unwrap();
    }
    let error = notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["one too many"]),
        120,
    )
    .unwrap_err();
    assert!(error.message.contains("limit is 10"), "{}", error.message);
    // The global list is a separate allowance.
    notes::add(&mut connection, None, &texts(&["global item"]), 200).unwrap();
    let (open, _) = notes::list(&connection).unwrap();
    assert_eq!(open.len(), 1 + notes::MAX_OPEN_THREAD as usize);
}

#[test]
fn cross_out_respects_thread_visibility_and_is_idempotent() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    let (thread_note, _) = notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["thread debt"]),
        120,
    )
    .unwrap();
    let (global_note, _) =
        notes::add(&mut connection, None, &texts(&["global debt"]), 200).unwrap();
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

    // A global note belongs to every Thread.
    let global_ids = vec![global_note[0].id.clone()];
    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-b"),
        &global_ids,
    )
    .unwrap();
    assert_eq!(outcome.crossed_out, global_ids);

    // The owner crosses their own notes regardless of the Thread.
    let (other, _) = notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["another debt"]),
        120,
    )
    .unwrap();
    let outcome = notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Owner,
        &[other[0].id.clone()],
    )
    .unwrap();
    assert_eq!(outcome.crossed_out.len(), 1);
}

#[test]
fn injection_shows_global_notes_and_this_threads_notes_only() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    insert_thread(&connection, "thread-b", "Thread B");
    assert!(
        notes::injection_block(&connection, "thread-a")
            .unwrap()
            .is_none()
    );
    notes::add(&mut connection, None, &texts(&["global item"]), 200).unwrap();
    notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["alpha item"]),
        120,
    )
    .unwrap();
    notes::add(
        &mut connection,
        Some("thread-b"),
        &texts(&["beta item"]),
        120,
    )
    .unwrap();
    let block = notes::injection_block(&connection, "thread-a")
        .unwrap()
        .unwrap();
    assert!(block.contains("Sticky notes — global (1):"), "{block}");
    assert!(block.contains("Sticky notes — this thread (1):"), "{block}");
    assert!(block.contains("global item"), "{block}");
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
    let (added, _) = notes::add(
        &mut connection,
        Some("thread-a"),
        &texts(&["finished item"]),
        120,
    )
    .unwrap();
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
        Some("thread-a"),
        &texts(&["a one", "a two"]),
        120,
    )
    .unwrap();
    notes::add(&mut connection, Some("thread-b"), &texts(&["b one"]), 120).unwrap();
    notes::add(&mut connection, None, &texts(&["global one"]), 200).unwrap();

    assert_eq!(notes::tear_thread(&connection, "thread-a").unwrap(), 2);
    let (open, _) = notes::list(&connection).unwrap();
    let texts = open
        .iter()
        .map(|note| (note.thread_id.as_deref(), note.text.as_str()))
        .collect::<Vec<_>>();
    // Global notes come first on the notes page; an attached note follows.
    assert_eq!(
        texts,
        vec![(None, "global one"), (Some("thread-b"), "b one")]
    );
}

#[test]
fn the_notes_page_reads_open_then_crossed_notes_with_their_thread_title() {
    let mut connection = notes_connection();
    insert_thread(&connection, "thread-a", "Thread A");
    let (added, _) = notes::add(
        &mut connection,
        Some("thread-a"),
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
    let (added, _) = notes::add(&mut connection, None, &texts(&["mistake"]), 200).unwrap();
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
