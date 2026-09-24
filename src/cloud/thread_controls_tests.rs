use super::*;
use crate::cloud::tests::{
    bind_thread_upstream, create_test_thread, insert_record, insert_upstream, read_json_request,
    test_state,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn record(state: &AppState, user: &User, thread: &ThreadView, input: RequestInput) -> i64 {
    let id = thread.id.clone();
    user_db(state, user, false, move |connection| {
        record_request(connection, &id, input).map(|(id, _)| id)
    })
    .await
    .unwrap()
}

fn model_upstream(address: SocketAddr) -> Upstream {
    Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: format!("http://{address}"),
        api_key: "fixture".to_owned(),
    }
}

/// Registers a fresh upstream row pointing at the mock listener and binds the
/// thread to it, so the request path resolves the mock through the database.
async fn bind_model(state: &AppState, user: &User, thread: &ThreadView, address: SocketAddr) {
    let upstream = insert_upstream(state, user, "fixture", &format!("http://{address}")).await;
    bind_thread_upstream(state, user, &thread.id, &upstream.id).await;
}

async fn reply(socket: &mut tokio::net::TcpStream, text: &str) {
    let body = json!({"id":"response", "output":[{
        "type":"message","id":"message","role":"assistant",
        "content":[{"type":"output_text","text":text}]
    }]})
    .to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

async fn reply_incomplete(socket: &mut tokio::net::TcpStream, reason: &str) {
    let body =
        json!({"id":"response","status":"incomplete","incomplete_details":{"reason":reason}})
            .to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

async fn reply_completed(socket: &mut tokio::net::TcpStream, text: &str) {
    let body = json!({"id":"response", "end_turn":true, "output":[{
        "type":"message","id":"message","role":"assistant",
        "content":[{"type":"output_text","text":text}]
    }]})
    .to_string();
    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

fn checkpoint_body(marker: &str) -> String {
    format!(
        "# Durable working context\n\n## Concepts and terminology\n- {marker}\n\n## Resources and authoritative locations\n- test\n\n## Chronicle timeline\n- record anchors\n\n## Active decisions and constraints\n- preserve history\n\n## Current objective and next step\n- continue\n\n## Open work and evidence routes\n[]"
    )
}

async fn wait_finished(state: &AppState, user: &User, thread: &ThreadView) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while state
            .active_requests
            .lock()
            .await
            .contains_key(&request_key(user, &thread.id))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn browser_controls_accept_empty_posts_and_enforce_authentication_and_ownership() {
    use crate::cloud::settings_tests::base64url;
    use ed25519_dalek::{Signer, SigningKey};

    let (_root, state) = test_state();
    let user = user_for_subject(&state, "http-controls-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let other = user_for_subject(&state, "http-controls-other").unwrap();
    let foreign = create_test_thread(&state, &other).await;
    let key = SigningKey::from_bytes(&[43; 32]);
    let jwks = json!({"keys":[{"kid":"test","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":base64url(&key.verifying_key().to_bytes())}]});
    let issuer_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", issuer_listener.local_addr().unwrap());
    let issuer_task = tokio::spawn(async move {
        axum::serve(
            issuer_listener,
            Router::new().route("/jwks", get(move || async { Json(jwks) })),
        )
        .await
        .unwrap();
    });
    let auth = AuthMiniLayer::from_issuer(&issuer, AUTH_AUDIENCE, JwksCachePolicy::default())
        .await
        .unwrap();
    assert!(state.auth.set(auth).is_ok());
    let claims = json!({"sub":user.id,"sid":"fixture","iss":issuer,"aud":AUTH_AUDIENCE,"amr":["webauthn"],"typ":"access","iat":now(),"exp":now()+60});
    let signing_input = format!(
        "{}.{}",
        base64url(br#"{"alg":"EdDSA","kid":"test"}"#),
        base64url(claims.to_string().as_bytes())
    );
    let token = format!(
        "{signing_input}.{}",
        base64url(&key.sign(signing_input.as_bytes()).to_bytes())
    );
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, upstream.local_addr().unwrap()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn({
        let state = state.clone();
        async move { axum::serve(listener, app(state)).await.unwrap() }
    });
    let client = reqwest::Client::new();
    for action in ["cancel", "continue", "compact"] {
        let path = format!("{base}/api/threads/{}/{action}", thread.id);
        assert_eq!(
            client.post(&path).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let foreign_path = format!("{base}/api/threads/{}/{action}", foreign.id);
        assert_eq!(
            client
                .post(foreign_path)
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    for action in ["continue", "compact"] {
        let path = format!("{base}/api/threads/{}/{action}", thread.id);
        assert_eq!(
            client
                .post(path)
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
    }
    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("saved prompt".to_owned()),
    )
    .await;
    finalize_request_success(&state, &user, &thread.id, first)
        .await
        .unwrap();
    for action in ["continue", "compact"] {
        let path = format!("{base}/api/threads/{}/{action}", thread.id);
        let ack: Value = client
            .post(&path)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ack["status"], "accepted");
        assert!(ack["record_idx"].as_i64().unwrap() > first);
        assert_eq!(
            client
                .post(&path)
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let cancelled: Value = client
            .post(format!("{base}/api/threads/{}/cancel", thread.id))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(cancelled["status"], "idle");
        assert_eq!(cancelled["display_status"], "stopped");
        wait_finished(&state, &user, &thread).await;
    }
    assert_eq!(
        history_for(&state, &user, thread.id, 0)
            .await
            .unwrap()
            .iter()
            .filter(|record| record.kind == "input")
            .count(),
        1
    );
    server.abort();
    issuer_task.abort();
}

#[tokio::test]
async fn continue_replays_saved_history_without_a_new_prompt() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "continue-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("original prompt".to_owned()),
    )
    .await;
    append_tool_output_item(
        &state,
        &user,
        &thread,
        first,
        &json!({"role":"assistant","content":"previous answer"}),
    )
    .await
    .unwrap();
    assert!(
        finalize_request_success(&state, &user, &thread.id, first)
            .await
            .unwrap()
    );
    let before = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let next = record(&state, &user, &thread, RequestInput::Continue).await;
    assert!(next > before.last().unwrap().id);
    assert!(
        !finalize_request_success(&state, &user, &thread.id, first)
            .await
            .unwrap()
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = model_upstream(listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_json_request(&mut socket).await;
        reply(&mut socket, "continued answer").await;
        request
    });
    let (_tx, mut rx) = watch::channel(false);
    let result = request_agent(&state, &user, &thread, &upstream, next, &mut rx)
        .await
        .unwrap();
    assert_eq!(result.1, "continued answer");
    let request = server.await.unwrap();
    let input = request["input"].as_array().unwrap();
    assert_eq!(
        input.iter().filter(|item| item["role"] == "user").count(),
        1
    );
    assert!(
        input
            .iter()
            .any(|item| item["content"] == "original prompt")
    );
    assert!(
        input
            .iter()
            .any(|item| item["content"] == "previous answer")
    );
    assert!(!request.to_string().contains("thread_control"));
    let after = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&after[..before.len()]).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    assert_eq!(
        after.iter().filter(|record| record.kind == "input").count(),
        1
    );
    assert_eq!(after.last().unwrap().kind, "response_output");
    assert_eq!(
        response_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .unwrap()
            .input_record_id,
        Some(next)
    );
    assert!(
        finalize_request_success(&state, &user, &thread.id, next)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn cancel_closes_the_in_flight_stream_and_preserves_committed_records() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "cancel-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_json_request(&mut socket).await;
        let item = json!({"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"durable","role":"assistant","content":[{"type":"output_text","text":"saved before stop"}]}});
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {item}\n\n").as_bytes()).await.unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read, 0, "cancellation must close the upstream connection");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "stopped inference must not issue another request"
        );
    });
    let ack = enqueue(
        state.clone(),
        user.clone(),
        thread.id.clone(),
        RequestInput::Prompt("original prompt".to_owned()),
    )
    .await
    .unwrap();
    let before = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let history = history_for(&state, &user, thread.id.clone(), 0)
                .await
                .unwrap();
            if history.len() == 2 {
                break history;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        cancel_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
    server.await.unwrap();
    wait_finished(&state, &user, &thread).await;
    let after = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&after[..before.len()]).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    assert_eq!(after.last().unwrap().payload["action"], "cancel");
    assert!(
        response_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !finalize_request_success(&state, &user, &thread.id, ack.record_idx)
            .await
            .unwrap()
    );
    let audits: Vec<String> = user_db(&state, &user, false, |connection| {
        connection
            .prepare("SELECT status FROM reasoning_audits")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    })
    .await
    .unwrap();
    assert_eq!(audits, ["cancelled"]);
    cancel_for(&state, &user, thread.id.clone()).await.unwrap();
    assert_eq!(
        history_for(&state, &user, thread.id, 0)
            .await
            .unwrap()
            .len(),
        after.len(),
        "stopping an idle thread is idempotent"
    );
}

#[tokio::test]
async fn compact_appends_one_checkpoint_and_does_not_resume_inference() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "compact-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let offline_worker = "00000000-0000-4000-8000-000000000099";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at) VALUES(?,'Offline laptop',?,1)",
            params![offline_worker, offline_worker],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("remember this".to_owned()),
    )
    .await;
    finalize_request_success(&state, &user, &thread.id, first)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_json_request(&mut socket).await;
        reply(&mut socket, "# Durable working context\n\n## Concepts and terminology\n- preserved\n\n## Resources and authoritative locations\n- test\n\n## Chronicle timeline\n- record #1\n\n## Active decisions and constraints\n- preserve history\n\n## Current objective and next step\n- continue\n\n## Open work and evidence routes\n[]").await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
        request
    });
    let ack = enqueue(
        state.clone(),
        user.clone(),
        thread.id.clone(),
        RequestInput::Compact,
    )
    .await
    .unwrap();
    wait_finished(&state, &user, &thread).await;
    let request = server.await.unwrap();
    assert_eq!(request["max_output_tokens"], 65_536);
    let input_items = request["input"].as_array().unwrap();
    let instruction = input_items.last().unwrap();
    assert_eq!(instruction["role"], "user");
    assert!(
        instruction["content"]
            .as_str()
            .unwrap()
            .contains("Checkpoint compaction")
    );
    assert!(
        instruction["content"]
            .as_str()
            .unwrap()
            .contains("Source record metadata")
    );
    assert!(
        request["input"][0]["content"]
            .as_str()
            .unwrap()
            .contains(offline_worker)
    );
    assert!(
        !request["input"][0]["content"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("cybion")
    );
    assert!(request.get("tools").is_none());
    assert_eq!(request["tool_choice"], "none");
    assert!(!request.to_string().contains("thread_control"));
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        history.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(),
        ["input", "activity", "checkpoint"]
    );
    assert_eq!(history[0].payload["content"], "remember this");
    assert_eq!(history[1].id, ack.record_idx);
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
    let next = record(&state, &user, &thread, RequestInput::Continue).await;
    let replay = user_db(&state, &user, false, move |connection| {
        let tail = request_context_tail(connection, &thread.id, next)?;
        compile_thread_context(connection, &thread.id, tail)
    })
    .await
    .unwrap();
    assert_eq!(replay.record_ids, [history[2].id]);
}

#[tokio::test]
async fn cancelled_generation_cannot_checkpoint_dispatch_tools_or_clear_its_replacement() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "generation-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("original".to_owned()),
    )
    .await;
    cancel_for(&state, &user, thread.id.clone()).await.unwrap();
    let next = record(&state, &user, &thread, RequestInput::Continue).await;
    let (tx, _rx) = watch::channel(false);
    state.active_requests.lock().await.insert(
        request_key(&user, &thread.id),
        ActiveRequest {
            record_idx: next,
            cancellation: tx,
        },
    );
    clear_current_request(&state, &user, &thread.id, first).await;
    assert!(is_current_request(&state, &user, &thread.id, next).await);
    let checkpoint_error = persist_thread_checkpoint(
        &state,
        &user,
        &thread,
        first,
        first,
        "obsolete checkpoint".to_owned(),
    )
    .await
    .unwrap_err();
    assert!(checkpoint_error.is_cancelled());
    let tool_error = enqueue_worker_call(
        &state,
        &user,
        "00000000-0000-4000-8000-000000000099",
        &thread.id,
        first,
        "stale-call".to_owned(),
        "function_call_output".to_owned(),
        "bash".to_owned(),
        json!({"command":"unused"}),
    )
    .await
    .unwrap_err();
    assert!(tool_error.is_cancelled());
    let late = ResponseItem::from_value(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"late response"}]})).unwrap();
    append_response_output_items(&state, &user, &thread, first, &[late])
        .await
        .unwrap();
    assert!(!finalize_request_failure(&state, &user, &thread, first, "late error").await);
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "running"
    );
    let history = history_for(&state, &user, thread.id, 0).await.unwrap();
    assert!(history[1..].iter().all(|r| r.kind == "activity"));
    assert_ne!(first, next);
}

#[tokio::test]
async fn controls_reject_empty_busy_and_other_users_threads_without_appending() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "owner").unwrap();
    let other = user_for_subject(&state, "other").unwrap();
    let thread = create_test_thread(&state, &user).await;
    create_test_thread(&state, &other).await;
    for input in [RequestInput::Continue, RequestInput::Compact] {
        let error = enqueue(state.clone(), user.clone(), thread.id.clone(), input)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::CONFLICT);
    }
    assert!(
        history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap()
            .is_empty()
    );
    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("original".to_owned()),
    )
    .await;
    for input in [RequestInput::Continue, RequestInput::Compact] {
        let error = enqueue(state.clone(), user.clone(), thread.id.clone(), input)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::CONFLICT);
    }
    for input in [RequestInput::Continue, RequestInput::Compact] {
        let error = enqueue(state.clone(), other.clone(), thread.id.clone(), input)
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
    }
    assert_eq!(
        cancel_for(&state, &other, thread.id.clone())
            .await
            .unwrap_err()
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap()
            .len(),
        1
    );
    finalize_request_success(&state, &user, &thread.id, first)
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let results = tokio::join!(
        enqueue(
            state.clone(),
            user.clone(),
            thread.id.clone(),
            RequestInput::Continue
        ),
        enqueue(
            state.clone(),
            user.clone(),
            thread.id.clone(),
            RequestInput::Compact
        ),
    );
    assert_eq!(
        usize::from(results.0.is_ok()) + usize::from(results.1.is_ok()),
        1
    );
    cancel_for(&state, &user, thread.id.clone()).await.unwrap();
    wait_finished(&state, &user, &thread).await;
}

#[tokio::test]
async fn cancel_marks_all_outstanding_worker_calls_and_keeps_late_results_as_activity() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "worker-cancel").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("original".to_owned()),
    )
    .await;
    let worker_id = "00000000-0000-4000-8000-000000000001";
    let thread_id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        connection.execute("INSERT INTO workers(id,label,token_hash,created_at) VALUES(?,'fixture','fixture',0)", [worker_id])?;
        for (id, status) in [("queued", "queued"), ("delivered", "delivered")] {
            connection.execute("INSERT INTO worker_calls(id,responses_call_id,worker_id,thread_id,input_record_id,name,arguments_json,status,created_at) VALUES(?,?,?,?,?,'bash','{}',?,0)", params![id,id,worker_id,thread_id,input,status])?;
        }
        insert_record(connection, &thread_id, "response_output", json!({"type":"function_call","call_id":"delivered","name":"bash","arguments":"{}"}));
        Ok(())
    }).await.unwrap();
    let (tx, mut rx) = watch::channel(false);
    state.active_requests.lock().await.insert(
        request_key(&user, &thread.id),
        ActiveRequest {
            record_idx: input,
            cancellation: tx,
        },
    );
    cancel_for(&state, &user, thread.id.clone()).await.unwrap();
    assert!(
        wait_worker_result(&state, &user, "delivered", &mut rx)
            .await
            .unwrap_err()
            .is_cancelled()
    );
    let statuses: Vec<String> = user_db(&state, &user, false, |connection| {
        connection
            .prepare("SELECT status FROM worker_calls ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    })
    .await
    .unwrap();
    assert_eq!(statuses, ["failed", "failed"]);
    let call_id = "00000000-0000-4000-8000-000000000002";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "UPDATE worker_calls SET id=? WHERE id='delivered'",
            [call_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker_id.to_owned(), call_id.to_owned())),
        axum::Extension(user.clone()),
        Json(WorkerResultInput {
            result: json!({"stdout":"late"}),
            failed: false,
            error: None,
        }),
    )
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id, 0).await.unwrap();
    assert_eq!(history.last().unwrap().kind, "activity");
    assert_eq!(history.last().unwrap().payload["call_id"], "delivered");
}

async fn assert_display_status(state: &AppState, user: &User, thread: &ThreadView, expected: &str) {
    let detail = read_thread_for(state, user, thread.id.clone())
        .await
        .unwrap();
    let list = list_threads_for(state, user).await.unwrap();
    let listed = list.iter().find(|item| item.id == thread.id).unwrap();
    assert_eq!(detail.display_status, expected);
    assert_eq!(listed.display_status, expected);
    assert_eq!(listed.status, detail.status);
}

#[tokio::test]
async fn display_status_distinguishes_ready_success_stop_failure_and_compaction() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "display-status-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    assert_eq!(thread.display_status, "ready");
    assert_display_status(&state, &user, &thread, "ready").await;

    let first = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("first".to_owned()),
    )
    .await;
    assert_display_status(&state, &user, &thread, "running").await;
    finalize_request_success(&state, &user, &thread.id, first)
        .await
        .unwrap();
    assert_display_status(&state, &user, &thread, "completed").await;

    let next = record(&state, &user, &thread, RequestInput::Continue).await;
    assert_display_status(&state, &user, &thread, "running").await;
    let cancelled = cancel_for(&state, &user, thread.id.clone()).await.unwrap();
    assert_eq!(cancelled.status, "idle");
    assert_eq!(cancelled.display_status, "stopped");
    assert_display_status(&state, &user, &thread, "stopped").await;
    assert!(
        !finalize_request_success(&state, &user, &thread.id, next)
            .await
            .unwrap()
    );
    assert!(!finalize_request_failure(&state, &user, &thread, next, "late failure").await);
    assert_display_status(&state, &user, &thread, "stopped").await;

    let compact = record(&state, &user, &thread, RequestInput::Compact).await;
    assert_display_status(&state, &user, &thread, "compacting").await;
    assert!(
        finalize_request_success(&state, &user, &thread.id, compact)
            .await
            .unwrap()
    );
    assert_display_status(&state, &user, &thread, "completed").await;
    // Renaming changes updated_at but is not an execution boundary.
    let id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "UPDATE threads SET title='Renamed',updated_at=updated_at+10 WHERE id=?",
            [id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert_display_status(&state, &user, &thread, "completed").await;

    let failed = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("fail".to_owned()),
    )
    .await;
    assert!(finalize_request_failure(&state, &user, &thread, failed, "upstream error").await);
    assert_display_status(&state, &user, &thread, "failed").await;
    let retry = record(&state, &user, &thread, RequestInput::Continue).await;
    assert_display_status(&state, &user, &thread, "running").await;
    finalize_request_success(&state, &user, &thread.id, retry)
        .await
        .unwrap();
    assert_display_status(&state, &user, &thread, "completed").await;
}

#[tokio::test]
async fn display_status_ignores_audits_and_late_output_and_is_scoped_to_the_thread() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "status-noise-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let untouched = create_test_thread(&state, &user).await;
    let initial = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("first".to_owned()),
    )
    .await;
    finalize_request_success(&state, &user, &thread.id, initial)
        .await
        .unwrap();
    let compact = record(&state, &user, &thread, RequestInput::Compact).await;
    // A newer user input supersedes the compact request, even before an audit exists.
    let prompt = record(
        &state,
        &user,
        &thread,
        RequestInput::Prompt("new prompt".to_owned()),
    )
    .await;
    assert!(
        !finalize_request_success(&state, &user, &thread.id, compact)
            .await
            .unwrap()
    );
    let id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        insert_record(connection, &id, "response_output", json!({"type":"message","content":"partial response"}));
        insert_record(connection, &id, "tool_output", json!({"type":"function_call_output","output":"done"}));
        insert_record(connection, &id, "activity", json!({"role":"system","content":"Request failed: stale","record_idx":compact}));
        connection.execute("INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at) VALUES(?,'title','test-model','completed',0)", [&id])?;
        Ok(())
    }).await.unwrap();
    assert_display_status(&state, &user, &thread, "running").await;
    finalize_request_success(&state, &user, &thread.id, prompt)
        .await
        .unwrap();
    let id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        // Raw activity payloads are valid stored history, not request boundaries.
        connection.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES(?,'activity','not JSON',0)", [id])?;
        Ok(())
    }).await.unwrap();
    assert_display_status(&state, &user, &thread, "completed").await;
    assert_display_status(&state, &user, &untouched, "ready").await;
    let other = user_for_subject(&state, "status-noise-other").unwrap();
    assert!(list_threads_for(&state, &other).await.unwrap().is_empty());
    assert!(read_thread_for(&state, &other, thread.id).await.is_err());
}

#[tokio::test]
async fn compaction_reduces_the_range_when_the_summary_exhausts_the_output_budget() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "compact-budget-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role":"user","content":"first"}),
            );
            insert_record(
                connection,
                &thread_id,
                "response_output",
                json!({"type":"message","id":"m1","role":"assistant","content":[{"type":"output_text","text":"second"}]}),
            );
            insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role":"user","content":"third"}),
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for index in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_json_request(&mut socket).await;
            if index == 0 {
                reply_incomplete(&mut socket, "max_output_tokens").await;
            } else {
                reply(&mut socket, &checkpoint_body("budget reduction")).await;
            }
            requests.push(request);
        }
        requests
    });
    enqueue(
        state.clone(),
        user.clone(),
        thread.id.clone(),
        RequestInput::Compact,
    )
    .await
    .unwrap();
    wait_finished(&state, &user, &thread).await;
    let requests = server.await.unwrap();
    assert_eq!(
        requests.len(),
        3,
        "output-budget exhaustion must reduce the range and retry"
    );
    let first = requests[0]["input"].as_array().unwrap().len();
    let second = requests[1]["input"].as_array().unwrap().len();
    assert!(
        second < first,
        "the retry must summarize a strictly smaller range: {first} -> {second}"
    );
    for request in &requests {
        assert_eq!(request["max_output_tokens"], 65_536);
    }
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(history.last().unwrap().kind, "checkpoint");
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
}

#[tokio::test]
async fn proactive_compaction_checkpoints_the_context_before_an_oversized_inference() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "proactive-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    user_db(&state, &user, false, |connection| {
        connection.execute(
            "INSERT INTO thread_defaults(id,model,reasoning_effort,service_tier_fast,context_budget_tokens)
             VALUES(1,'test-model','medium',0,1000)
             ON CONFLICT(id) DO UPDATE SET context_budget_tokens=1000",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role":"user","content":"x".repeat(8_000)}),
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for index in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_json_request(&mut socket).await;
            if index == 0 {
                reply(&mut socket, &checkpoint_body("proactive")).await;
            } else {
                reply_completed(&mut socket, "done").await;
            }
            requests.push(request);
        }
        requests
    });
    enqueue(
        state.clone(),
        user.clone(),
        thread.id.clone(),
        RequestInput::Prompt("please continue".to_owned()),
    )
    .await
    .unwrap();
    wait_finished(&state, &user, &thread).await;
    let requests = server.await.unwrap();
    assert_eq!(
        requests.len(),
        2,
        "the oversized context must be checkpointed before inference"
    );
    let instruction = requests[0]["input"].as_array().unwrap().last().unwrap();
    assert!(
        instruction["content"]
            .as_str()
            .unwrap()
            .contains("Checkpoint compaction")
    );
    assert_eq!(requests[0]["max_output_tokens"], 65_536);
    assert!(
        requests[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["content"]
                .as_str()
                .is_some_and(|text| text.contains("# Durable working context"))),
        "inference must replay the fresh checkpoint"
    );
    assert!(requests[1].get("max_output_tokens").is_none());
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert!(
        history.iter().any(|record| record.kind == "checkpoint"),
        "the proactive checkpoint must be durable"
    );
    assert_eq!(
        read_thread_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .status,
        "idle"
    );
}

#[tokio::test]
async fn disabled_context_budget_skips_proactive_compaction() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "budget-off-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO thread_defaults(id,model,reasoning_effort,service_tier_fast,context_budget_tokens)
             VALUES(1,'test-model','medium',0,1000)
             ON CONFLICT(id) DO UPDATE SET context_budget_tokens=1000",
            [],
        )?;
        connection.execute(
            "UPDATE threads SET context_budget_tokens=0 WHERE id=?",
            [&thread_id],
        )?;
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({"role":"user","content":"x".repeat(8_000)}),
        );
        Ok(())
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    bind_model(&state, &user, &thread, listener.local_addr().unwrap()).await;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_json_request(&mut socket).await;
        reply_completed(&mut socket, "done").await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err(),
            "a disabled budget must not issue a compaction request"
        );
        request
    });
    enqueue(
        state.clone(),
        user.clone(),
        thread.id.clone(),
        RequestInput::Prompt("please continue".to_owned()),
    )
    .await
    .unwrap();
    wait_finished(&state, &user, &thread).await;
    let request = server.await.unwrap();
    assert!(request.get("max_output_tokens").is_none());
    assert!(request.to_string().contains("please continue"));
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert!(history.iter().all(|record| record.kind != "checkpoint"));
}

#[tokio::test]
async fn context_estimate_prefers_the_measured_anchor_and_resets_after_a_checkpoint() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "estimate-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let (first, second, appended_bytes) = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            let first = insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role":"user","content":"a".repeat(400)}),
            );
            connection.execute(
                "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,idx_head,idx_tail,input_tokens)
                 VALUES(?,'inference','test-model','completed',0,?,?,250)",
                params![thread_id, first, first],
            )?;
            let second = insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role":"user","content":"b".repeat(400)}),
            );
            let appended_bytes: i64 = connection.query_row(
                "SELECT length(payload) FROM history_records WHERE id=?",
                [second],
                |row| row.get(0),
            )?;
            Ok((first, second, appended_bytes))
        }
    })
    .await
    .unwrap();
    let anchored = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| estimate_context_tokens(connection, &thread_id, first, second)
    })
    .await
    .unwrap();
    assert_eq!(
        anchored,
        250 + (appended_bytes + CONTEXT_ESTIMATE_BYTES_PER_TOKEN - 1)
            / CONTEXT_ESTIMATE_BYTES_PER_TOKEN,
        "a fresh measured anchor plus appended bytes prices the next request"
    );
    let (checkpoint, range_bytes) = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            let checkpoint = insert_record(
                connection,
                &thread_id,
                "checkpoint",
                json!({"role":"developer","content":"summary"}),
            );
            let range_bytes: i64 = connection.query_row(
                "SELECT COALESCE(SUM(length(payload)),0) FROM history_records
                 WHERE thread_id=? AND id>=? AND id<=?
                   AND kind IN ('input','response_output','tool_output','checkpoint')",
                params![thread_id, first, checkpoint],
                |row| row.get(0),
            )?;
            Ok((checkpoint, range_bytes))
        }
    })
    .await
    .unwrap();
    let after_checkpoint = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| estimate_context_tokens(connection, &thread_id, first, checkpoint)
    })
    .await
    .unwrap();
    assert_eq!(
        after_checkpoint,
        (range_bytes + CONTEXT_ESTIMATE_BYTES_PER_TOKEN - 1) / CONTEXT_ESTIMATE_BYTES_PER_TOKEN,
        "a checkpoint newer than the anchor forces a full-range estimate"
    );
    assert!(after_checkpoint < anchored);
}
