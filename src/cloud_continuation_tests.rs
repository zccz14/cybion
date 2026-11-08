use super::tests::{create_test_thread, test_state};
use super::*;

fn continuation_connection() -> Connection {
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

fn open_notes(connection: &mut Connection, thread_id: &str, values: &[&str]) -> usize {
    let texts = values
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    notes::add(connection, thread_id, &texts, 120).unwrap().1 as usize
}

fn activity<T: Fn(&Value) -> bool>(
    connection: &Connection,
    thread_id: &str,
    matches: T,
) -> Vec<Value> {
    connection
        .prepare(
            "SELECT payload FROM history_records WHERE thread_id=? AND kind='activity' ORDER BY id",
        )
        .unwrap()
        .query_map([thread_id], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| serde_json::from_str::<Value>(&row.unwrap()).unwrap())
        .filter(|payload| matches(payload))
        .collect()
}

fn is_continuation(payload: &Value) -> bool {
    payload["type"] == "notes_continuation"
}

fn is_stopped(payload: &Value) -> bool {
    payload["type"] == "notes_continuation_stopped"
}

#[test]
fn nothing_owed_means_the_turn_ends() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    assert!(
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .is_none()
    );
    assert!(activity(&connection, "thread-a", |_| true).is_empty());
}

#[test]
fn a_blocked_thread_is_never_handed_back() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(&mut connection, "thread-a", &["pay the rent"]);
    blocked::block(&connection, "thread-a").unwrap();
    assert!(
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .is_none()
    );
    assert!(activity(&connection, "thread-a", is_continuation).is_empty());
}

#[test]
fn open_notes_hand_the_turn_back_with_the_runtime_nudge() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(&mut connection, "thread-a", &["pay the rent"]);
    let nudge = continuation::decide_in(&mut connection, "thread-a", 7)
        .unwrap()
        .unwrap();
    assert!(nudge.starts_with(&format!(
        "[Runtime continuation 1 of {}",
        continuation::MAX_PER_TURN
    )));
    assert!(nudge.contains("The 1 note above is still open"));
    assert!(nudge.contains("not the user"));
    assert!(nudge.contains("block_thread"));
    let recorded = activity(&connection, "thread-a", is_continuation);
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0]["nudge"], 1);
    assert_eq!(recorded[0]["open"], 1);
    assert_eq!(recorded[0]["input_record_id"], 7);
}

#[test]
fn the_last_continuation_says_the_thread_stops_after_it() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(
        &mut connection,
        "thread-a",
        &["pay the rent", "book the room"],
    );
    for _ in 1..continuation::MAX_PER_TURN {
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .unwrap();
    }
    let nudge = continuation::decide_in(&mut connection, "thread-a", 7)
        .unwrap()
        .unwrap();
    assert!(nudge.starts_with(&format!(
        "[Runtime continuation {0} of {0}, the last one",
        continuation::MAX_PER_TURN
    )));
    assert!(nudge.contains("the Thread stops after this turn"));
    assert!(nudge.contains("the remaining 2 notes"));
}

#[test]
fn the_nudge_warns_before_the_budget_runs_out() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(&mut connection, "thread-a", &["pay the rent"]);
    let mut warned = 0;
    for _ in 1..continuation::MAX_PER_TURN {
        let nudge = continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .unwrap();
        if nudge.contains("more than half spent") {
            warned += 1;
            assert!(
                !nudge.contains("the last one"),
                "the warning is not the last word"
            );
        }
    }
    // Exactly the hand-backs past half the budget warn; the last one escalates
    // instead of warning.
    assert_eq!(
        warned,
        continuation::MAX_PER_TURN - continuation::MAX_PER_TURN / 2 - 1
    );
}

#[test]
fn the_budget_stops_the_turn_and_records_that_once() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(&mut connection, "thread-a", &["pay the rent"]);
    for _ in 0..continuation::MAX_PER_TURN {
        assert!(
            continuation::decide_in(&mut connection, "thread-a", 7)
                .unwrap()
                .is_some()
        );
    }
    assert!(
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .is_none()
    );
    // A second settlement of the same turn must not stack stop records.
    assert!(
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .is_none()
    );
    let stopped = activity(&connection, "thread-a", is_stopped);
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0]["open"], 1);
}

#[test]
fn a_finished_note_frees_the_turn_and_another_input_gets_its_own_budget() {
    let mut connection = continuation_connection();
    insert_thread(&connection, "thread-a");
    open_notes(&mut connection, "thread-a", &["pay the rent"]);
    continuation::decide_in(&mut connection, "thread-a", 7)
        .unwrap()
        .unwrap();
    // Crossing the last note out ends the loop entirely.
    let (open, _) = notes::list(&connection).unwrap();
    notes::cross_out(
        &mut connection,
        notes::CrossOutAuthority::Thread("thread-a"),
        &[open[0].id.clone()],
    )
    .unwrap();
    assert!(
        continuation::decide_in(&mut connection, "thread-a", 7)
            .unwrap()
            .is_none()
    );
    // A new input record is a new turn with a fresh budget.
    open_notes(&mut connection, "thread-a", &["pay the electricity"]);
    let nudge = continuation::decide_in(&mut connection, "thread-a", 8)
        .unwrap()
        .unwrap();
    assert!(nudge.starts_with(&format!(
        "[Runtime continuation 1 of {}",
        continuation::MAX_PER_TURN
    )));
}

#[test]
fn the_deployment_switch_defaults_on_and_can_be_switched_off() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("default.sqlite3");
    assert_eq!(
        admin_meta_int_sync(&path, notes::CONTINUATION_KEY, 1).unwrap(),
        1
    );
    set_admin_meta_int_sync(&path, notes::CONTINUATION_KEY, 0).unwrap();
    assert_eq!(
        admin_meta_int_sync(&path, notes::CONTINUATION_KEY, 1).unwrap(),
        0
    );
}

#[tokio::test]
async fn the_switch_off_stops_the_loop_before_it_records_anything() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "continuation-switch-user").unwrap();
    let thread = create_test_thread(&state, &user).await.id;
    user_db(&state, &user, true, {
        let thread = thread.clone();
        move |connection| {
            notes::add(connection, &thread, &["pay the rent".to_owned()], 120)?;
            Ok(())
        }
    })
    .await
    .unwrap();
    assert!(
        continuation::decide(&state, &user, &thread, 1)
            .await
            .unwrap()
            .is_some()
    );
    set_admin_meta_int_sync(&state.admin_db_path, notes::CONTINUATION_KEY, 0).unwrap();
    assert!(
        continuation::decide(&state, &user, &thread, 2)
            .await
            .unwrap()
            .is_none()
    );
}
