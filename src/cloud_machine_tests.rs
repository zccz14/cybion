use super::machines::MachineEffect;
use super::*;

fn machine_connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut connection).unwrap();
    connection
}

fn insert_worker(connection: &Connection, id: &str, online: bool) {
    let (status, seen) = if online {
        ("online", Some(now()))
    } else {
        ("offline", None)
    };
    connection
        .execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,?,?,?,?,?)",
            params![id, format!("Worker {id}"), format!("hash-{id}"), now(), status, seen],
        )
        .unwrap();
}

fn insert_thread(connection: &Connection, id: &str) {
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,?,?, 'idle',?,?)",
            params![id, "终极机器 · check", "model", now(), now()],
        )
        .unwrap();
}

fn insert_machine(
    connection: &Connection,
    id: &str,
    worker_id: &str,
    thread_id: &str,
    interval_seconds: i64,
    intent: Option<&str>,
) {
    connection
        .execute(
            "INSERT INTO machines(id,name,worker_id,command,intent,interval_seconds,thread_id,enabled,created_at) VALUES(?,?,?,?,?,?,?,1,?)",
            params![id, "磁盘检查", worker_id, "test -f /tmp/ultimate-machine-ok", intent, interval_seconds, thread_id, now()],
        )
        .unwrap();
}

fn insert_delivered_call(
    connection: &Connection,
    call_id: &str,
    machine_id: &str,
    created_at: i64,
) {
    connection
        .execute(
            "INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at,started_at,machine_id) VALUES(?,?,?,?,'{}','delivered',?,?,?)",
            params![call_id, "w1", "t1", "bash", created_at, created_at + 1, machine_id],
        )
        .unwrap();
}

fn call_count(connection: &Connection, machine_id: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM worker_calls WHERE machine_id=?",
            [machine_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn due_machine_dispatches_one_run_and_waits_for_it_to_settle() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);

    // The first check runs immediately after creation, silently.
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 1);
    let (name, status, arguments, machine_id): (String, String, String, Option<String>) = connection
        .query_row(
            "SELECT name,status,arguments_json,machine_id FROM worker_calls WHERE machine_id='m1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(name, "bash");
    assert_eq!(status, "queued");
    assert_eq!(machine_id.as_deref(), Some("m1"));
    let arguments: Value = serde_json::from_str(&arguments).unwrap();
    assert_eq!(arguments["command"], "test -f /tmp/ultimate-machine-ok");
    assert_eq!(arguments["timeout_seconds"], 300);

    // The open run keeps the guard: no second dispatch.
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 1);
}

#[test]
fn completed_failure_asks_the_thread_and_waits_one_interval() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);
    insert_delivered_call(&connection, "c1", "m1", now() - 10);

    let effect = machines::settle_call_result(
        &connection,
        "w1",
        "c1",
        &json!({"exit_code": 3, "stdout": "", "stderr": "disk full"}).to_string(),
        "completed",
        None,
    )
    .unwrap();
    let Some(MachineEffect::ThreadMessage { thread_id, text }) = effect else {
        panic!("expected a repair request");
    };
    assert_eq!(thread_id, "t1");
    assert!(text.contains("exit=3"));
    assert!(text.contains("disk full"));
    assert!(text.contains("test -f /tmp/ultimate-machine-ok"));
    let (status, exit, last_run): (String, Option<i64>, Option<i64>) = (
        connection
            .query_row("SELECT status FROM worker_calls WHERE id='c1'", [], |row| {
                row.get(0)
            })
            .unwrap(),
        connection
            .query_row("SELECT last_exit FROM machines WHERE id='m1'", [], |row| {
                row.get(0)
            })
            .unwrap(),
        connection
            .query_row(
                "SELECT last_run_at FROM machines WHERE id='m1'",
                [],
                |row| row.get(0),
            )
            .unwrap(),
    );
    assert_eq!(status, "completed");
    assert_eq!(exit, Some(3));
    assert!(last_run.unwrap() >= now() - 5);

    // The interval starts at the settled run, so nothing is due yet.
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 1);

    // Backdating the last run makes the machine due again.
    connection
        .execute(
            "UPDATE machines SET last_run_at=? WHERE id='m1'",
            [now() - 601],
        )
        .unwrap();
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 2);
}

#[test]
fn zero_exit_settles_silently() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);
    insert_delivered_call(&connection, "c1", "m1", now() - 10);

    let effect = machines::settle_call_result(
        &connection,
        "w1",
        "c1",
        &json!({"exit_code": 0, "stdout": "ok", "stderr": ""}).to_string(),
        "completed",
        None,
    )
    .unwrap();
    assert!(matches!(effect, Some(MachineEffect::Silent)));
    let exit: Option<i64> = connection
        .query_row("SELECT last_exit FROM machines WHERE id='m1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(exit, Some(0));
}

#[test]
fn offline_worker_reports_once_until_a_dispatch_resets_it() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", false);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);

    let effects = machines::run_due_machines(&connection).unwrap();
    assert!(
        matches!(effects.as_slice(), [MachineEffect::Linkit { text }] if text.contains("当前离线")),
        "expected one offline notice, got {effects:?}"
    );
    // A long outage stays quiet until it recovers.
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 0);

    connection
        .execute(
            "UPDATE workers SET status='online',last_seen_at=? WHERE id='w1'",
            [now()],
        )
        .unwrap();
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 1);
    let notified: Option<i64> = connection
        .query_row(
            "SELECT offline_notified_at FROM machines WHERE id='m1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(notified.is_none());
}

#[test]
fn lost_run_is_declared_once_and_the_next_interval_dispatches_again() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);
    insert_delivered_call(&connection, "c1", "m1", now() - 1000);

    let effects = machines::run_due_machines(&connection).unwrap();
    assert!(
        matches!(effects.as_slice(), [MachineEffect::Linkit { text }] if text.contains("未能完成")),
        "expected one lost-run notice, got {effects:?}"
    );
    let (status, failure): (String, Option<String>) = connection
        .query_row(
            "SELECT status,failure_code FROM worker_calls WHERE id='c1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(status, "failed");
    assert_eq!(failure.as_deref(), Some("machine_run_expired"));

    // The loss is declared once; the next interval dispatches a fresh run.
    assert!(machines::run_due_machines(&connection).unwrap().is_empty());
    assert_eq!(call_count(&connection, "m1"), 2);
}

#[test]
fn update_machine_rewrites_fields_retitles_the_thread_and_clears_intent() {
    let connection = machine_connection();
    insert_worker(&connection, "11111111-1111-1111-1111-111111111111", true);
    insert_worker(&connection, "22222222-2222-2222-2222-222222222222", true);
    insert_thread(&connection, "t1");
    insert_machine(
        &connection,
        "m1",
        "11111111-1111-1111-1111-111111111111",
        "t1",
        600,
        None,
    );
    connection
        .execute(
            "UPDATE threads SET title=? WHERE id='t1'",
            ["终极机器 · 磁盘检查"],
        )
        .unwrap();
    let view = machines::update_machine(
        &connection,
        "m1",
        machines::UpdateMachineInput {
            enabled: Some(false),
            name: Some("磁盘检查 v2".to_owned()),
            worker_id: Some("22222222-2222-2222-2222-222222222222".to_owned()),
            command: Some("df -Pk / >/dev/null".to_owned()),
            intent: Some("确保根分区低于 90%".to_owned()),
            interval_seconds: Some(900),
        },
    )
    .unwrap();
    let view = serde_json::to_value(&view).unwrap();
    assert_eq!(view["name"].as_str(), Some("磁盘检查 v2"));
    assert_eq!(
        view["worker_id"].as_str(),
        Some("22222222-2222-2222-2222-222222222222")
    );
    assert_eq!(view["command"].as_str(), Some("df -Pk / >/dev/null"));
    assert_eq!(view["interval_seconds"].as_i64(), Some(900));
    assert_eq!(view["enabled"].as_bool(), Some(false));
    assert_eq!(view["intent"].as_str(), Some("确保根分区低于 90%"));
    let title: String = connection
        .query_row("SELECT title FROM threads WHERE id='t1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "终极机器 · 磁盘检查 v2");

    // A user-renamed Thread keeps its title, and an empty intent clears the field.
    connection
        .execute("UPDATE threads SET title='我的维修线' WHERE id='t1'", [])
        .unwrap();
    let view = machines::update_machine(
        &connection,
        "m1",
        machines::UpdateMachineInput {
            enabled: None,
            name: Some("磁盘检查 v3".to_owned()),
            worker_id: None,
            command: None,
            intent: Some(String::new()),
            interval_seconds: None,
        },
    )
    .unwrap();
    let view = serde_json::to_value(&view).unwrap();
    assert!(view["intent"].is_null());
    let title: String = connection
        .query_row("SELECT title FROM threads WHERE id='t1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(title, "我的维修线");
}

#[test]
fn update_machine_rejects_invalid_interval_and_unknown_worker_without_touching_the_row() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(&connection, "m1", "w1", "t1", 600, None);
    assert!(
        machines::update_machine(
            &connection,
            "m1",
            machines::UpdateMachineInput {
                enabled: None,
                name: None,
                worker_id: None,
                command: None,
                intent: None,
                interval_seconds: Some(5),
            },
        )
        .is_err()
    );
    assert!(
        machines::update_machine(
            &connection,
            "m1",
            machines::UpdateMachineInput {
                enabled: None,
                name: None,
                worker_id: Some("00000000-0000-0000-0000-000000000000".to_owned()),
                command: None,
                intent: None,
                interval_seconds: None,
            },
        )
        .is_err()
    );
    let (name, interval, enabled): (String, i64, bool) = connection
        .query_row(
            "SELECT name,interval_seconds,enabled FROM machines WHERE id='m1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!((name.as_str(), interval, enabled), ("磁盘检查", 600, true));
}

#[test]
fn failure_message_carries_the_intent_when_set() {
    let connection = machine_connection();
    insert_worker(&connection, "w1", true);
    insert_thread(&connection, "t1");
    insert_machine(
        &connection,
        "m1",
        "w1",
        "t1",
        600,
        Some("确保根分区低于 90%"),
    );
    insert_delivered_call(&connection, "c1", "m1", now() - 10);
    let effect = machines::settle_call_result(
        &connection,
        "w1",
        "c1",
        &json!({"exit_code": 5, "stdout": "", "stderr": "no space"}).to_string(),
        "completed",
        None,
    )
    .unwrap();
    let Some(MachineEffect::ThreadMessage { text, .. }) = effect else {
        panic!("expected a repair request");
    };
    assert!(text.contains("意图：\n确保根分区低于 90%"));
    assert!(text.contains("exit=5"));
}
