use super::tests::{insert_upstream, test_state};
use super::*;

async fn insert_worker(state: &AppState, user: &User, id: &str) {
    let id = id.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,?,?,?, 'online', ?)",
            params![id.as_str(), format!("Worker {id}"), format!("hash-{id}"), now(), now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn set_default_upstream(state: &AppState, user: &User, upstream_id: &str) {
    let upstream_id = upstream_id.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO thread_defaults(id,model,upstream_id,reasoning_effort,service_tier_fast,context_budget_tokens,minimal_mode,image_generation_model) VALUES(1,'test-model',?,'medium',0,200000,0,'')
             ON CONFLICT(id) DO UPDATE SET model=excluded.model,upstream_id=excluded.upstream_id",
            params![upstream_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn ensure_user_db(state: &AppState, user: &User) {
    user_db(state, user, true, |_| Ok(())).await.unwrap();
}

async fn thread_title(state: &AppState, user: &User, thread_id: &str) -> String {
    let thread_id = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        connection
            .query_row(
                "SELECT title FROM threads WHERE id=?",
                [&thread_id],
                |row| row.get(0),
            )
            .map_err(ApiError::from)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn set_tool_creates_machines_for_list_and_get() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-user").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000401";
    insert_worker(&state, &user, worker_id).await;

    let created = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "磁盘检查",
            "worker_id": worker_id,
            "command": "test -f /tmp/ultimate-machine-ok",
            "intent": "确保根分区低于 90%",
            "interval_seconds": 600
        })
        .to_string(),
    )
    .await
    .unwrap();
    let machine_id = created["id"].as_str().unwrap().to_owned();
    let thread_id = created["thread_id"].as_str().unwrap().to_owned();
    assert_eq!(created["name"], "磁盘检查");
    assert_eq!(created["worker_id"], worker_id);
    assert_eq!(created["worker_label"], format!("Worker {worker_id}"));
    assert_eq!(created["enabled"], true);
    assert_eq!(created["interval_seconds"], 600);
    assert_eq!(created["last_run_at"], Value::Null);
    assert_eq!(created["last_exit"], Value::Null);
    assert_eq!(
        thread_title(&state, &user, &thread_id).await,
        "终极机器 · 磁盘检查"
    );

    let listed = machines::list_tool_output(&state, &user).await.unwrap();
    let items = listed["machines"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], machine_id.as_str());

    let read = machines::get_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str() }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(read["intent"], "确保根分区低于 90%");
    assert_eq!(read["thread_title"], "终极机器 · 磁盘检查");
}

#[tokio::test]
async fn set_tool_requires_create_fields_and_treats_enabled_as_update_only() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-args").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000402";
    insert_worker(&state, &user, worker_id).await;

    let error = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "worker_id": worker_id,
            "command": "true",
            "interval_seconds": 60
        })
        .to_string(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("requires name"), "{}", error.message);

    let error = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "x",
            "worker_id": worker_id,
            "command": "true",
            "interval_seconds": 60,
            "enabled": false
        })
        .to_string(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("updates only"), "{}", error.message);

    let error = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "x",
            "worker_id": "00000000-0000-4000-8000-000000000499",
            "command": "true",
            "interval_seconds": 60
        })
        .to_string(),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("Worker not found"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn set_tool_updates_partially_pauses_and_clears_intent() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-update").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000403";
    insert_worker(&state, &user, worker_id).await;
    let created = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "磁盘检查",
            "worker_id": worker_id,
            "command": "test -f /tmp/ultimate-machine-ok",
            "intent": "确保根分区低于 90%",
            "interval_seconds": 600
        })
        .to_string(),
    )
    .await
    .unwrap();
    let machine_id = created["id"].as_str().unwrap().to_owned();
    let thread_id = created["thread_id"].as_str().unwrap().to_owned();

    let updated = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "machine_id": machine_id.as_str(),
            "name": "磁盘检查 v2",
            "enabled": false,
            "interval_seconds": 900,
            "intent": ""
        })
        .to_string(),
    )
    .await
    .unwrap();
    assert_eq!(updated["name"], "磁盘检查 v2");
    assert_eq!(updated["enabled"], false);
    assert_eq!(updated["interval_seconds"], 900);
    assert_eq!(updated["intent"], Value::Null);
    assert_eq!(updated["worker_id"], worker_id);
    assert_eq!(updated["command"], "test -f /tmp/ultimate-machine-ok");

    assert_eq!(
        thread_title(&state, &user, &thread_id).await,
        "终极机器 · 磁盘检查 v2"
    );
}

#[tokio::test]
async fn get_tool_reports_unknown_and_invalid_ids() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-missing").unwrap();
    ensure_user_db(&state, &user).await;

    let error = machines::get_tool_output(
        &state,
        &user,
        &json!({ "machine_id": "00000000-0000-4000-8000-000000000498" }).to_string(),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("machine not found"),
        "{}",
        error.message
    );

    let error = machines::get_tool_output(
        &state,
        &user,
        &json!({ "machine_id": "not-a-uuid" }).to_string(),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("record not found"),
        "{}",
        error.message
    );
}

async fn machine_calls(state: &AppState, user: &User, machine_id: &str) -> i64 {
    let machine_id = machine_id.to_owned();
    user_db(state, user, false, move |connection| {
        connection
            .query_row(
                "SELECT COUNT(*) FROM worker_calls WHERE machine_id=?",
                [&machine_id],
                |row| row.get(0),
            )
            .map_err(ApiError::from)
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn delete_tool_removes_the_machine_and_keeps_its_repair_thread() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-delete").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000404";
    insert_worker(&state, &user, worker_id).await;
    let created = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "磁盘检查",
            "worker_id": worker_id,
            "command": "test -f /tmp/ultimate-machine-ok",
            "interval_seconds": 600
        })
        .to_string(),
    )
    .await
    .unwrap();
    let machine_id = created["id"].as_str().unwrap().to_owned();
    let thread_id = created["thread_id"].as_str().unwrap().to_owned();

    let deleted = machines::delete_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str() }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["machine"]["id"], machine_id.as_str());
    assert_eq!(deleted["machine"]["thread_id"], thread_id.as_str());

    let listed = machines::list_tool_output(&state, &user).await.unwrap();
    assert!(listed["machines"].as_array().unwrap().is_empty());
    let error = machines::get_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str() }).to_string(),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("machine not found"),
        "{}",
        error.message
    );
    // The repair Thread outlives the machine as an ordinary Thread.
    assert_eq!(
        thread_title(&state, &user, &thread_id).await,
        "终极机器 · 磁盘检查"
    );

    let error = machines::delete_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str() }).to_string(),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("machine not found"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn pausing_a_machine_stops_its_repair_thread_and_pending_run() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-pause").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000405";
    insert_worker(&state, &user, worker_id).await;
    let created = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "磁盘检查",
            "worker_id": worker_id,
            "command": "test -f /tmp/ultimate-machine-ok",
            "interval_seconds": 600
        })
        .to_string(),
    )
    .await
    .unwrap();
    let machine_id = created["id"].as_str().unwrap().to_owned();
    let thread_id = created["thread_id"].as_str().unwrap().to_owned();
    user_db(&state, &user, true, {
        let thread_id = thread_id.clone();
        move |connection| {
            connection.execute(
                "UPDATE threads SET status='running' WHERE id=?",
                [&thread_id],
            )?;
            connection.execute(
                "INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at) VALUES('repair-call',?,?,'bash','{}','queued',?)",
                params![worker_id, thread_id, now()],
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();

    machines::set_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str(), "enabled": false }).to_string(),
    )
    .await
    .unwrap();

    let (status, call_status) = user_db(&state, &user, false, {
        let thread_id = thread_id.clone();
        move |connection| {
            Ok((
                connection.query_row(
                    "SELECT status FROM threads WHERE id=?",
                    [&thread_id],
                    |row| row.get::<_, String>(0),
                )?,
                connection.query_row(
                    "SELECT status FROM worker_calls WHERE id='repair-call'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
            ))
        }
    })
    .await
    .unwrap();
    assert_eq!(status, "idle");
    assert_eq!(call_status, "cancelled");
}

#[tokio::test]
async fn a_finished_thread_turn_checks_the_machine_immediately() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "machine-tool-immediate").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    set_default_upstream(&state, &user, &upstream.id).await;
    let worker_id = "00000000-0000-4000-8000-000000000406";
    insert_worker(&state, &user, worker_id).await;
    let created = machines::set_tool_output(
        &state,
        &user,
        &json!({
            "name": "磁盘检查",
            "worker_id": worker_id,
            "command": "test -f /tmp/ultimate-machine-ok",
            "interval_seconds": 600
        })
        .to_string(),
    )
    .await
    .unwrap();
    let machine_id = created["id"].as_str().unwrap().to_owned();
    let thread_id = created["thread_id"].as_str().unwrap().to_owned();

    machines::check_after_thread_turn(&state, &user, &thread_id).await;
    assert_eq!(machine_calls(&state, &user, &machine_id).await, 1);
    // A run is still in flight: the next finished turn does not dispatch one more.
    machines::check_after_thread_turn(&state, &user, &thread_id).await;
    assert_eq!(machine_calls(&state, &user, &machine_id).await, 1);

    // A paused machine stops checking right away and drops the pending run.
    machines::set_tool_output(
        &state,
        &user,
        &json!({ "machine_id": machine_id.as_str(), "enabled": false }).to_string(),
    )
    .await
    .unwrap();
    machines::check_after_thread_turn(&state, &user, &thread_id).await;
    assert_eq!(machine_calls(&state, &user, &machine_id).await, 1);
}
