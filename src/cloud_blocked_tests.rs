use super::tests::{create_test_thread, test_state};
use super::*;

fn blocked_connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut connection).unwrap();
    connection
}

fn insert_thread(connection: &Connection, id: &str) {
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,?,?,'idle',?,?)",
            params![id, id, "model", now(), now()],
        )
        .unwrap();
}

fn blocked(connection: &Connection, id: &str) -> i64 {
    connection
        .query_row("SELECT blocked FROM threads WHERE id=?", [id], |row| {
            row.get(0)
        })
        .unwrap()
}

fn insert_record(connection: &Connection, thread_id: &str, kind: &str) -> i64 {
    persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id,
            kind,
            payload: &json!({"content": "hello"}),
            created_at: now(),
        },
    )
    .unwrap()
}

fn display_status(connection: &Connection, id: &str) -> String {
    connection
        .query_row(
            &format!(
                "{THREAD_VIEW_SELECT}
                LEFT JOIN ({THREAD_USAGE_SELECT} WHERE thread_id=?1 GROUP BY thread_id) usage
                  ON usage.thread_id=t.id
                WHERE t.id=?1"
            ),
            [id],
            thread_from_row,
        )
        .unwrap()
        .display_status
}

#[test]
fn the_user_schema_creates_a_blocked_flag_that_defaults_to_off() {
    let connection = blocked_connection();
    insert_thread(&connection, "thread-a");
    assert_eq!(blocked(&connection, "thread-a"), 0);
    let names: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('threads')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert!(names.contains(&"blocked".to_owned()));
}

#[test]
fn blocking_marks_the_thread_and_survives_the_turn_end() {
    let connection = blocked_connection();
    insert_thread(&connection, "thread-a");
    assert!(blocked::block(&connection, "thread-a").unwrap());
    // Finalization writes idle on the runtime axis; the block is a different
    // column, so the turn ending cannot clear it.
    connection
        .execute("UPDATE threads SET status='idle' WHERE id='thread-a'", [])
        .unwrap();
    assert_eq!(blocked(&connection, "thread-a"), 1);
}

#[test]
fn a_user_message_clears_the_block_and_any_other_record_leaves_it() {
    let connection = blocked_connection();
    insert_thread(&connection, "thread-a");
    blocked::block(&connection, "thread-a").unwrap();

    insert_record(&connection, "thread-a", "tool_output");
    insert_record(&connection, "thread-a", "response_output");
    insert_record(&connection, "thread-a", "checkpoint");
    assert_eq!(blocked(&connection, "thread-a"), 1);

    insert_record(&connection, "thread-a", "input");
    assert_eq!(blocked(&connection, "thread-a"), 0);
}

#[test]
fn a_blocked_thread_reports_blocked_instead_of_completed_or_ready() {
    let connection = blocked_connection();
    insert_thread(&connection, "thread-a");
    insert_record(&connection, "thread-a", "input");
    assert_eq!(display_status(&connection, "thread-a"), "completed");

    blocked::block(&connection, "thread-a").unwrap();
    assert_eq!(display_status(&connection, "thread-a"), "blocked");
}

#[test]
fn a_running_or_failed_thread_keeps_its_own_state_while_blocked() {
    let connection = blocked_connection();
    insert_thread(&connection, "thread-a");
    blocked::block(&connection, "thread-a").unwrap();

    connection
        .execute(
            "UPDATE threads SET status='running' WHERE id='thread-a'",
            [],
        )
        .unwrap();
    assert_eq!(display_status(&connection, "thread-a"), "running");

    connection
        .execute("UPDATE threads SET status='failed' WHERE id='thread-a'", [])
        .unwrap();
    assert_eq!(display_status(&connection, "thread-a"), "failed");
}

#[tokio::test]
async fn the_blocked_view_lists_only_blocked_active_threads() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "blocked-view-user").unwrap();
    let waiting = create_test_thread(&state, &user).await.id;
    let working = create_test_thread(&state, &user).await.id;
    user_db(&state, &user, true, {
        let waiting = waiting.clone();
        move |connection| blocked::block(connection, &waiting)
    })
    .await
    .unwrap();

    let page = list_threads_for(
        &state,
        &user,
        ThreadListFilter {
            blocked: true,
            ..ThreadListFilter::default()
        },
        MAX_THREAD_LIST_LIMIT,
        None,
    )
    .await
    .unwrap();
    let ids = page
        .items
        .iter()
        .map(|thread| thread.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(ids, [waiting]);
    assert_eq!(page.total, 1);
    assert!(!ids.contains(&working));
}
