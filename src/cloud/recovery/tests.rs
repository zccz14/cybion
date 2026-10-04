use super::*;
use crate::cloud::tests::{
    bind_thread_upstream, create_test_thread, insert_record, insert_upstream, test_state,
};
use std::sync::atomic::{AtomicUsize, Ordering};

type Requests = Arc<Mutex<Vec<Value>>>;
async fn fixture() -> (tempfile::TempDir, AppState, User, ThreadView, i64) {
    let (root, state) = test_state();
    let user = user_for_subject(&state, "recovery-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = user_db(&state, &user, false, {
        let id = thread.id.clone();
        move |c| {
            c.execute("UPDATE threads SET status='running' WHERE id=?", [&id])?;
            Ok(insert_record(
                c,
                &id,
                "input",
                json!({"role":"user","content":"original"}),
            ))
        }
    })
    .await
    .unwrap();
    (root, state, user, thread, input)
}
async fn model(statuses: Vec<StatusCode>) -> (String, Requests, tokio::task::JoinHandle<()>) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let counter = Arc::new(AtomicUsize::new(0));
    let app=Router::new().route("/responses",post({let requests=requests.clone();move |Json(value):Json<Value>|{
        let requests=requests.clone();let statuses=statuses.clone();let counter=counter.clone();
        async move {
            requests.lock().await.push(value);
            let i=counter.fetch_add(1,Ordering::SeqCst);
            let status=statuses.get(i).copied().unwrap_or(StatusCode::OK);
            let body=if status.is_success(){json!({"id":format!("response-{i}"),"end_turn":true,"output":[{"type":"message","id":format!("message-{i}"),"role":"assistant","content":[{"type":"output_text","text":"finished"}]}]})}
                else {json!({"error":{"code":"temporary","message":"temporary upstream failure"}})};
            (status,[("retry-after","0")],Json(body))
        }
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, requests, task)
}

/// Points the thread at a fresh upstream row serving the mock base URL.
async fn bind_mock(state: &AppState, user: &User, thread: &ThreadView, base: &str) {
    let upstream = insert_upstream(state, user, "mock", base).await;
    bind_thread_upstream(state, user, &thread.id, &upstream.id).await;
}
async fn wait_finished(state: &AppState, user: &User, thread: &ThreadView) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !state
                .active_requests
                .lock()
                .await
                .contains_key(&request_key(user, &thread.id))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
async fn seed_worker(state: &AppState, user: &User) -> String {
    let id = Uuid::new_v4().to_string();
    user_db(state,user,false,{let id=id.clone();move|c|{
        c.execute("INSERT INTO workers(id,label,token_hash,status,last_seen_at,created_at) VALUES(?,'fixture',?,'online',?,?)",params![id,hash_secret("fixture"),now(),now()])?;Ok(())
    }}).await.unwrap();
    id
}

#[tokio::test]
async fn restart_resumes_only_running_threads_once_from_latest_committed_history() {
    let (_root, state, user, thread, input) = fixture().await;
    let idle = create_test_thread(&state, &user).await;
    let failed = create_test_thread(&state, &user).await;
    user_db(&state, &user, false, {
        let id = failed.id.clone();
        move |c| {
            c.execute("UPDATE threads SET status='failed' WHERE id=?", [id])?;
            Ok(())
        }
    })
    .await
    .unwrap();
    append_response_output_items(&state,&user,&thread,input,&[ResponseItem::from_value(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"committed progress"}]})).unwrap()]).await.unwrap();
    let (base, requests, server) = model(vec![]).await;
    bind_mock(&state, &user, &thread, &base).await;
    recover_interrupted_requests(&state.data_dir).unwrap();
    let (a, b) = tokio::join!(resume_running(&state), resume_running(&state));
    a.unwrap();
    b.unwrap();
    wait_finished(&state, &user, &thread).await;
    assert_eq!(requests.lock().await.len(), 1);
    assert!(
        requests.lock().await[0]["input"]
            .to_string()
            .contains("committed progress")
    );
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(history.iter().filter(|r| r.kind == "input").count(), 1);
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
    assert_eq!(
        read_thread_for(&state, &user, idle.id)
            .await
            .unwrap()
            .status,
        "idle"
    );
    assert_eq!(
        read_thread_for(&state, &user, failed.id)
            .await
            .unwrap()
            .status,
        "failed"
    );
    resume_running(&state).await.unwrap();
    assert_eq!(requests.lock().await.len(), 1);
    server.abort();
}

#[tokio::test]
async fn restart_waits_for_original_tool_and_replays_its_result_without_creating_another_call() {
    let (_root, state, user, thread, input) = fixture().await;
    let worker = seed_worker(&state, &user).await;
    let item=ResponseItem::from_value(json!({"type":"function_call","id":"tool","call_id":"original-call","name":"bash","arguments":json!({"worker_id":worker,"command":"echo once"}).to_string()})).unwrap();
    append_response_output_items(&state, &user, &thread, input, &[item])
        .await
        .unwrap();
    let call = user_db(&state, &user, false, |c| {
        Ok(c.query_row("SELECT id FROM worker_calls", [], |r| r.get::<_, String>(0))?)
    })
    .await
    .unwrap();
    user_db(&state, &user, false, {
        let worker = worker.clone();
        move |c| {
            assert!(worker_protocol::claim(c, &worker, None)?.is_some());
            Ok(())
        }
    })
    .await
    .unwrap();
    let (base, requests, server) = model(vec![]).await;
    bind_mock(&state, &user, &thread, &base).await;
    recover_interrupted_requests(&state.data_dir).unwrap();
    resume_running(&state).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(requests.lock().await.is_empty());
    for _ in 0..2 {
        let _ = worker_result(
            State(state.clone()),
            AxumPath((user.id.clone(), worker.clone(), call.clone())),
            axum::Extension(user.clone()),
            Json(WorkerResultInput {
                result: json!({"stdout":"once"}),
                failed: false,
                error: None,
            }),
        )
        .await
        .unwrap();
    }
    wait_finished(&state, &user, &thread).await;
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == "original-call")
    );
    assert_eq!(
        history_for(&state, &user, thread.id, 0)
            .await
            .unwrap()
            .iter()
            .filter(|r| r.kind == "tool_output")
            .count(),
        1
    );
    user_db(&state, &user, false, |c| {
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM worker_calls", [], |r| r
                .get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .await
    .unwrap();
    server.abort();
}

#[tokio::test]
async fn transient_requests_retry_but_permanent_errors_do_not() {
    for status in [
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::GATEWAY_TIMEOUT,
        StatusCode::UNAUTHORIZED,
    ] {
        let (_root, state, user, thread, _) = fixture().await;
        let (base, requests, server) = model(vec![status]).await;
        bind_mock(&state, &user, &thread, &base).await;
        resume_running(&state).await.unwrap();
        wait_finished(&state, &user, &thread).await;
        let permanent = status == StatusCode::UNAUTHORIZED;
        assert_eq!(requests.lock().await.len(), if permanent { 1 } else { 2 });
        assert_eq!(
            read_thread_for(&state, &user, thread.id)
                .await
                .unwrap()
                .status,
            if permanent { "failed" } else { "idle" }
        );
        server.abort();
    }
}

#[tokio::test]
async fn output_budget_exhaustion_schedules_a_bounded_retry() {
    let (_root, state, user, thread, input) = fixture().await;
    let error = ApiError::output_budget_exhausted(
        "Incomplete response returned, reason: max_output_tokens",
    );
    for n in 1..=5 {
        assert_eq!(
            retry(&state, &user, &thread.id, input, &error)
                .await
                .unwrap(),
            n < 5
        );
    }
    let id = thread.id.clone();
    user_db(&state, &user, false, move |c| {
        assert_eq!(
            c.query_row("SELECT retry_count FROM threads WHERE id=?", [id], |r| r
                .get::<_, i64>(0))?,
            5
        );
        Ok(())
    })
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let message = format!(
        "Transient model error; retry 1/{} scheduled: Incomplete response returned, reason: max_output_tokens",
        MAX_FAILURES - 1
    );
    assert_eq!(
        history
            .iter()
            .filter(|record| record.kind == "activity"
                && record.payload["content"].as_str() == Some(message.as_str()))
            .count(),
        1
    );
    assert_eq!(
        read_thread_for(&state, &user, thread.id)
            .await
            .unwrap()
            .status,
        "failed"
    );
}

#[tokio::test]
async fn truncated_inference_stream_retries_and_finishes_the_turn() {
    let (_root, state, user, thread, _) = fixture().await;
    let requests: Requests = Arc::new(Mutex::new(Vec::new()));
    let counter = Arc::new(AtomicUsize::new(0));
    let app = Router::new().route(
        "/responses",
        post({
            let requests = requests.clone();
            let counter = counter.clone();
            move |Json(value): Json<Value>| {
                let requests = requests.clone();
                let counter = counter.clone();
                async move {
                    requests.lock().await.push(value);
                    let body = if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                        json!({"id":"response-0","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}})
                    } else {
                        json!({"id":"response-1","end_turn":true,"output":[{"type":"message","id":"message-1","role":"assistant","content":[{"type":"output_text","text":"finished"}]}]})
                    };
                    Json(body)
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    bind_mock(&state, &user, &thread, &base).await;
    resume_running(&state).await.unwrap();
    wait_finished(&state, &user, &thread).await;
    let requests = requests.lock().await;
    assert_eq!(
        requests.len(),
        2,
        "a response stopped at the output cap must retry the inference request"
    );
    assert!(requests[1]["input"].to_string().contains("original"));
    drop(requests);
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
    let history = history_for(&state, &user, thread.id, 0).await.unwrap();
    let retried = history
        .iter()
        .filter(|record| record.kind == "activity")
        .any(|record| {
            record.payload["content"]
                .as_str()
                .is_some_and(|text| text.contains("retry 1/4 scheduled"))
        });
    assert!(retried);
    server.abort();
}

#[tokio::test]
async fn retry_budget_is_durable_and_exhaustion_cannot_be_reset_by_restart() {
    let (_root, state, user, thread, input) = fixture().await;
    let error = ApiError::transient("temporary", Some(0));
    for n in 1..=5 {
        assert_eq!(
            retry(&state, &user, &thread.id, input, &error)
                .await
                .unwrap(),
            n < 5
        );
    }
    recover_interrupted_requests(&state.data_dir).unwrap();
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "failed"
    );
    resume_running(&state).await.unwrap();
    assert!(state.active_requests.lock().await.is_empty());
    user_db(&state, &user, false, move |c| {
        assert_eq!(
            c.query_row(
                "SELECT retry_count FROM threads WHERE id=?",
                [thread.id],
                |r| r.get::<_, i64>(0)
            )?,
            5
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn retry_wait_is_cancelable_and_stale_request_cannot_change_the_new_thread() {
    let (_root, state, user, thread, input) = fixture().await;
    retry(
        &state,
        &user,
        &thread.id,
        input,
        &ApiError::transient("temporary", Some(600_000)),
    )
    .await
    .unwrap();
    let (tx, mut rx) = watch::channel(false);
    let task = tokio::spawn({
        let state = state.clone();
        let user = user.clone();
        let thread = thread.clone();
        async move { wait_retry(&state, &user, &thread.id, input, &mut rx).await }
    });
    tx.send(true).unwrap();
    assert!(task.await.unwrap().unwrap_err().is_cancelled());
    user_db(&state, &user, false, {
        let id = thread.id.clone();
        move |c| {
            insert_record(c, &id, "input", json!({"role":"user","content":"new"}));
            Ok(())
        }
    })
    .await
    .unwrap();
    assert!(
        retry(
            &state,
            &user,
            &thread.id,
            input,
            &ApiError::transient("old", None)
        )
        .await
        .unwrap_err()
        .is_cancelled()
    );
    assert!(
        !finalize_request_success(&state, &user, &thread.id, input)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn tool_output_and_queue_creation_roll_back_together_on_storage_failure() {
    let (_root, state, user, thread, input) = fixture().await;
    let worker = seed_worker(&state, &user).await;
    user_db(&state,&user,false,|c|{c.execute_batch("CREATE TRIGGER reject_call BEFORE INSERT ON worker_calls BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;")?;Ok(())}).await.unwrap();
    let item=ResponseItem::from_value(json!({"type":"function_call","call_id":"call","name":"bash","arguments":json!({"worker_id":worker,"command":"echo once"}).to_string()})).unwrap();
    assert!(
        append_response_output_items(&state, &user, &thread, input, &[item])
            .await
            .is_err()
    );
    let history = history_for(&state, &user, thread.id, 0).await.unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|r| r.kind == "response_output")
            .count(),
        0
    );
}

// Test-only fixture for scripts/smoke-thread-recovery.py. Never compiled into
// the release service; uses isolated databases and synthetic credentials.
#[tokio::test]
#[ignore]
async fn write_restart_fixture() {
    let home = PathBuf::from(std::env::var("CYBION_SMOKE_HOME").unwrap());
    let base = std::env::var("CYBION_SMOKE_MODEL_URL").unwrap();
    let (_root, state, user, thread, _) = fixture().await;
    let worker = seed_worker(&state, &user).await;
    let upstream = insert_upstream(&state, &user, "fixture", &base).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    Connection::open(&user.path)
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let users = home.join(".cybion/users");
    fs::create_dir_all(&users).unwrap();
    fs::copy(&user.path, users.join(format!("{}.sqlite3", user.id))).unwrap();
    fs::write(
        home.join("fixture.json"),
        json!({"user_id":user.id,"thread_id":thread.id,"worker_id":worker,"token":"fixture"})
            .to_string(),
    )
    .unwrap();
}

// Runs the production startup/router/recovery code on a test-only ephemeral
// address, so the crash smoke test never stops a developer's existing service.
#[tokio::test]
#[ignore]
async fn serve_smoke_controller() {
    crate::cloud::serve_at(std::env::var("CYBION_SMOKE_ADDR").unwrap().parse().unwrap())
        .await
        .unwrap();
}

#[tokio::test]
async fn repeated_committed_call_id_is_not_appended_or_enqueued_twice() {
    let (_root, state, user, thread, input) = fixture().await;
    let worker = seed_worker(&state, &user).await;
    let item=ResponseItem::from_value(json!({"type":"function_call","id":"tool","call_id":"same","name":"bash","arguments":json!({"worker_id":worker,"command":"echo once"}).to_string()})).unwrap();
    let first =
        append_response_output_items(&state, &user, &thread, input, std::slice::from_ref(&item))
            .await
            .unwrap();
    let second = append_response_output_items(&state, &user, &thread, input, &[item])
        .await
        .unwrap();
    assert_eq!(first, second);
    user_db(&state, &user, false, |c| {
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM worker_calls", [], |r| r
                .get::<_, i64>(0))?,
            1
        );
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        history_for(&state, &user, thread.id, 0)
            .await
            .unwrap()
            .iter()
            .filter(|r| r.kind == "response_output")
            .count(),
        1
    );
}

async fn seed_delivered_call(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    input: i64,
    call_id: &str,
    command: &str,
) -> (String, String) {
    let worker = seed_worker(state, user).await;
    let item = ResponseItem::from_value(json!({
        "type":"function_call","id":"tool","call_id":call_id,"name":"bash",
        "arguments":json!({"worker_id":worker,"command":command,"timeout_seconds":1}).to_string()
    }))
    .unwrap();
    append_response_output_items(state, user, thread, input, &[item])
        .await
        .unwrap();
    let id = user_db(state, user, false, {
        let call_id = call_id.to_owned();
        move |c| {
            Ok(c.query_row(
                "SELECT id FROM worker_calls WHERE responses_call_id=?",
                [call_id],
                |r| r.get::<_, String>(0),
            )?)
        }
    })
    .await
    .unwrap();
    user_db(state, user, false, {
        let worker = worker.clone();
        move |c| {
            assert!(worker_protocol::claim(c, &worker, None)?.is_some());
            Ok(())
        }
    })
    .await
    .unwrap();
    (worker, id)
}

#[tokio::test]
async fn worker_call_timeout_requests_cancellation_and_leaves_it_pending() {
    let (_root, state, user, thread, input) = fixture().await;
    let (_worker, call) = seed_delivered_call(
        &state,
        &user,
        &thread,
        input,
        "timeout-request",
        "sleep 999",
    )
    .await;
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            c.execute(
                "UPDATE worker_calls SET started_at=? WHERE id=?",
                params![now() - 1000, call],
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();
    recover_interrupted_requests(&state.data_dir).unwrap();
    resume_running(&state).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let requested: i64 = user_db(&state, &user, false, {
                let call = call.clone();
                move |c| {
                    Ok(c.query_row(
                        "SELECT COALESCE(cancel_requested_at,0) FROM worker_calls WHERE id=?",
                        [call],
                        |r| r.get(0),
                    )?)
                }
            })
            .await
            .unwrap();
            if requested > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            let (status, notified): (String, Option<i64>) = c.query_row(
                "SELECT status,cancel_notified_at FROM worker_calls WHERE id=?",
                [call],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(status, "delivered", "the call keeps waiting for the Worker");
            assert_eq!(
                notified, None,
                "an unbound Worker process cannot be notified"
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    if let Some(request) = state
        .active_requests
        .lock()
        .await
        .remove(&request_key(&user, &thread.id))
    {
        let _ = request.cancellation.send(true);
    }
}

#[tokio::test]
async fn unconfirmed_timeout_answers_the_call_with_a_cleanup_instruction() {
    let (_root, state, user, thread, input) = fixture().await;
    let (_worker, call) = seed_delivered_call(
        &state,
        &user,
        &thread,
        input,
        "timeout-fallback",
        "sleep 999",
    )
    .await;
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            c.execute(
                "UPDATE worker_calls SET started_at=?,cancel_requested_at=? WHERE id=?",
                params![now() - 1000, now() - 1000, call],
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();
    let (base, requests, server) = model(vec![]).await;
    bind_mock(&state, &user, &thread, &base).await;
    recover_interrupted_requests(&state.data_dir).unwrap();
    resume_running(&state).await.unwrap();
    wait_finished(&state, &user, &thread).await;
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            let (status, code, completed, output, notified): (
                String,
                Option<String>,
                Option<i64>,
                Option<i64>,
                Option<i64>,
            ) = c.query_row(
                "SELECT status,failure_code,completed_at,output_record_id,cancel_notified_at FROM worker_calls WHERE id=?",
                [call],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;
            assert_eq!(status, "failed");
            assert_eq!(code.as_deref(), Some("timeout_cancel_unconfirmed"));
            assert!(completed.is_some());
            assert!(output.is_some());
            assert_eq!(
                notified, None,
                "the pending cancellation must still reach a returning Worker"
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let outputs = history
        .iter()
        .filter(|record| record.kind == "tool_output")
        .collect::<Vec<_>>();
    assert_eq!(outputs.len(), 1);
    let output = outputs[0].payload["output"].as_str().unwrap();
    assert!(output.contains("timeout_cancel_unconfirmed"), "{output}");
    assert!(output.contains("clean it up"), "{output}");
    assert_eq!(outputs[0].payload["call_id"], "timeout-fallback");
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]["input"]
            .to_string()
            .contains("timeout_cancel_unconfirmed")
    );
    drop(requests);
    server.abort();
}

#[tokio::test]
async fn a_worker_answer_confirms_the_cancellation_without_the_fallback() {
    let (_root, state, user, thread, input) = fixture().await;
    let (worker, call) = seed_delivered_call(
        &state,
        &user,
        &thread,
        input,
        "timeout-confirmed",
        "sleep 999",
    )
    .await;
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            c.execute(
                "UPDATE worker_calls SET started_at=?,cancel_requested_at=? WHERE id=?",
                params![now() - 1000, now() - 2, call],
            )?;
            Ok(())
        }
    })
    .await
    .unwrap();
    let (base, requests, server) = model(vec![]).await;
    bind_mock(&state, &user, &thread, &base).await;
    recover_interrupted_requests(&state.data_dir).unwrap();
    resume_running(&state).await.unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker.clone(), call.clone())),
        axum::Extension(user.clone()),
        Json(WorkerResultInput {
            result: json!({"error":"Bash command cancelled by the Controller"}),
            failed: true,
            error: None,
        }),
    )
    .await
    .unwrap();
    wait_finished(&state, &user, &thread).await;
    user_db(&state, &user, false, {
        let call = call.clone();
        move |c| {
            let (status, code, error): (String, Option<String>, Option<String>) = c.query_row(
                "SELECT status,failure_code,error FROM worker_calls WHERE id=?",
                [call],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(status, "failed");
            assert_eq!(code, None, "the Worker confirmed the cancellation");
            assert!(
                error.as_deref().unwrap_or_default().contains("cancelled"),
                "{error:?}"
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let outputs = history
        .iter()
        .filter(|record| record.kind == "tool_output")
        .collect::<Vec<_>>();
    assert_eq!(outputs.len(), 1);
    let output = outputs[0].payload["output"].as_str().unwrap();
    assert!(output.contains("cancelled"), "{output}");
    assert!(history.iter().all(|record| {
        !record
            .payload
            .to_string()
            .contains("timeout_cancel_unconfirmed")
    }));
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0]["input"].to_string().contains("cancelled"));
    drop(requests);
    server.abort();
}

#[tokio::test]
async fn cancellation_notices_cover_user_stops_and_unconfirmed_timeouts() {
    let (_root, state, user, thread, _) = fixture().await;
    let worker = seed_worker(&state, &user).await;
    user_db(&state, &user, false, {
        let worker = worker.clone();
        let thread = thread.id.clone();
        move |c| {
            c.execute("UPDATE workers SET boot_id='boot' WHERE id=?", [&worker])?;
            for (id, status, requested, notified, completed) in [
                ("stopped", "cancelled", None, None, 1_i64),
                ("timed", "failed", Some(2_i64), None, 2_i64),
                ("notified", "cancelled", None, Some(3_i64), 3_i64),
                ("plain", "failed", None, None, 4_i64),
            ] {
                c.execute(
                    "INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,status,created_at,worker_boot_id,cancel_requested_at,cancel_notified_at,completed_at) VALUES(?,?,?,'bash','{}',?,10,'boot',?,?,?)",
                    params![id, worker, thread, status, requested, notified, completed],
                )?;
            }
            Ok(())
        }
    })
    .await
    .unwrap();
    user_db(&state, &user, false, move |c| {
        assert_eq!(
            worker_protocol::cancel_notice(c, &worker, Some("boot"))?.as_deref(),
            Some("stopped")
        );
        assert_eq!(
            worker_protocol::cancel_notice(c, &worker, Some("boot"))?.as_deref(),
            Some("timed")
        );
        assert_eq!(
            worker_protocol::cancel_notice(c, &worker, Some("boot"))?,
            None
        );
        let notified = {
            let mut q = c.prepare(
                "SELECT id FROM worker_calls WHERE cancel_notified_at IS NOT NULL ORDER BY id",
            )?;
            q.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        assert_eq!(notified, ["notified", "stopped", "timed"]);
        Ok(())
    })
    .await
    .unwrap();
}
