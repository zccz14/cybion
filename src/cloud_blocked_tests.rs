use super::tests::{create_test_thread, test_state};
use super::*;
use tokio::io::AsyncWriteExt;

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

// --- USD budget -----------------------------------------------------------

fn budget_records(connection: &Connection, id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM history_records WHERE thread_id=? AND kind='activity'
               AND json_extract(payload,'$.budget_usd_nanos') IS NOT NULL",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn a_budget_stop_blocks_marks_one_record_and_stays_marked() {
    let mut connection = blocked_connection();
    insert_thread(&connection, "t");
    let text = blocked::stop_for_budget(&mut connection, "t", 500_000_000, 620_000_000, None).unwrap();
    assert!(text.starts_with("Budget exhausted:"), "{text}");
    assert!(text.contains("$0.62"), "{text}");
    assert!(text.contains("$0.50"), "{text}");
    assert_eq!(blocked(&connection, "t"), 1);
    assert_eq!(display_status(&connection, "t"), "blocked");
    assert_eq!(budget_records(&connection, "t"), 1);
    // Resuming the same Thread reaches the gate again; it must not stack up
    // records or repaint the state the user is waiting on.
    blocked::stop_for_budget(&mut connection, "t", 500_000_000, 620_000_000, None).unwrap();
    assert_eq!(budget_records(&connection, "t"), 1);
}

#[test]
fn the_next_user_message_clears_a_budget_block() {
    let mut connection = blocked_connection();
    insert_thread(&connection, "t");
    blocked::stop_for_budget(&mut connection, "t", 1_000, 2_000, None).unwrap();
    assert_eq!(blocked(&connection, "t"), 1);
    insert_record(&connection, "t", "input");
    assert_eq!(blocked(&connection, "t"), 0);
}

// Raising the limit is only an adjustment; the user then resumes the Thread with
// Continue, which writes a `thread_control` record rather than an `input` one. If
// that path left `blocked=1` alone, the Thread would run the turn the user paid
// for and then paint itself as blocked again the moment it finalized.
#[test]
fn the_users_own_continue_clears_a_budget_block() {
    let mut connection = blocked_connection();
    insert_thread(&connection, "t");
    // Continue needs protocol history to resume from; write it raw so the seeded
    // record cannot clear the flag this test is about.
    connection
        .execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at)
             VALUES('t','input','{\"content\":\"hello\"}',?)",
            [now()],
        )
        .unwrap();
    blocked::stop_for_budget(&mut connection, "t", 500_000_000, 620_000_000, None).unwrap();
    assert_eq!(blocked(&connection, "t"), 1);
    assert_eq!(display_status(&connection, "t"), "blocked");

    let (idx, operation) = thread_controls::record_request(
        &mut connection,
        &std::env::temp_dir(),
        "t",
        thread_controls::RequestInput::Continue,
    )
    .unwrap();
    assert_eq!(operation, RequestOperation::Inference);
    // A control record, not an input: the model still gets no new words from the user.
    assert_eq!(
        connection
            .query_row(
                "SELECT kind FROM history_records WHERE id=?",
                [idx],
                |row| { row.get::<_, String>(0) }
            )
            .unwrap(),
        "activity"
    );
    assert_eq!(blocked(&connection, "t"), 0);
    // The turn is queued now, so the projection reports what it is doing rather
    // than the state it was waiting in.
    assert_eq!(display_status(&connection, "t"), "running");
}

// Compact spends no budget, so it is not a resume and must not quietly lift a
// block the user never answered.
#[test]
fn compact_does_not_clear_a_budget_block() {
    let mut connection = blocked_connection();
    insert_thread(&connection, "t");
    connection
        .execute(
            "INSERT INTO history_records(thread_id,kind,payload,created_at)
             VALUES('t','input','{\"content\":\"hello\"}',?)",
            [now()],
        )
        .unwrap();
    blocked::stop_for_budget(&mut connection, "t", 500_000_000, 620_000_000, None).unwrap();
    thread_controls::record_request(
        &mut connection,
        &std::env::temp_dir(),
        "t",
        thread_controls::RequestInput::Compact,
    )
    .unwrap();
    assert_eq!(blocked(&connection, "t"), 1);
}

#[tokio::test]
async fn a_thread_at_its_budget_blocks_before_asking_the_upstream() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "budget-gate-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = user_db(&state, &user, true, {
        let id = thread.id.clone();
        move |c| {
            let idx = insert_record(c, &id, "input");
            c.execute(
                "UPDATE threads SET budget_usd_nanos=200,status='running' WHERE id=?",
                [&id],
            )?;
            c.execute(
                "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,finished_at,cost_usd_nanos)
                 VALUES(?,'inference','model','completed',?,?,250)",
                params![id, now(), now()],
            )?;
            Ok(idx)
        }
    })
    .await
    .unwrap();
    // An unreachable base URL: reaching the upstream at all fails the turn, so
    // an Ok answer proves the gate stopped before any paid request.
    let upstream = Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: "http://127.0.0.1:1".to_owned(),
        api_key: "fixture".to_owned(),
    };
    let (_tx, mut rx) = watch::channel(false);
    let (_, text) = tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(text.starts_with("Budget exhausted:"), "{text}");
    user_db(&state, &user, false, move |c| {
        assert_eq!(blocked(c, &thread.id), 1);
        assert_eq!(budget_records(c, &thread.id), 1);
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_thread_under_its_budget_and_one_without_a_budget_both_run() {
    // The gate must not fire, so the turn goes on to the upstream. A gateway
    // that answers 400 is refused outright rather than retried, which keeps
    // the negative case as fast as the positive one.
    for (label, budget) in [("under", Some(200_i64)), ("none", None), ("off", Some(0))] {
        let (_root, state) = test_state();
        let user = user_for_subject(&state, &format!("budget-open-{label}")).unwrap();
        let thread = create_test_thread(&state, &user).await;
        let input = user_db(&state, &user, true, {
            let id = thread.id.clone();
            move |c| {
                let idx = insert_record(c, &id, "input");
                c.execute(
                    "UPDATE threads SET budget_usd_nanos=?,status='running' WHERE id=?",
                    params![budget, id],
                )?;
                c.execute(
                    "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,finished_at,cost_usd_nanos)
                     VALUES(?,'inference','model','completed',?,?,150)",
                    params![id, now(), now()],
                )?;
                Ok(idx)
            }
        })
        .await
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let body = "{\"error\":{\"message\":\"refused\"}}";
            let _ = socket
                .write_all(
                    format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
        });
        let upstream = Upstream {
            id: "fixture-upstream".to_owned(),
            name: "fixture".to_owned(),
            base_url: format!("http://{address}"),
            api_key: "fixture".to_owned(),
        };
        let (_tx, mut rx) = watch::channel(false);
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            request_agent(&state, &user, &thread, &upstream, input, &mut rx),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "{label}: the turn must reach the upstream");
        user_db(&state, &user, false, move |c| {
            assert_eq!(blocked(c, &thread.id), 0);
            assert_eq!(budget_records(c, &thread.id), 0);
            Ok(())
        })
        .await
        .unwrap();
    }
}
