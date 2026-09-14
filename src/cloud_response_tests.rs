use super::tests::{create_test_thread, insert_record, read_json_request, test_state};
use super::*;
use crate::responses::{ResponseCompleted, ResponseEvent};
use tokio::io::AsyncWriteExt;

async fn input_record(state: &AppState, user: &User, thread: &ThreadView) -> i64 {
    let id = thread.id.clone();
    user_db(state, user, false, move |connection| {
        Ok(insert_record(
            connection,
            &id,
            "input",
            json!({"role":"user","content":"hello"}),
        ))
    })
    .await
    .unwrap()
}

fn completed(id: &str, end_turn: bool) -> ResponseEvent {
    ResponseEvent::Completed(
        serde_json::from_value::<ResponseCompleted>(json!({"id":id,"end_turn":end_turn})).unwrap(),
    )
}

#[tokio::test]
async fn thread_persists_deltas_and_dispatches_worker_before_response_completed() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "streaming-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000001";
    user_db(&state, &user, false, move |connection| {
        connection.execute("INSERT INTO workers(id,label,token_hash,created_at,last_seen_at,status) VALUES(?,'fixture',?,?,?,'online')", params![worker_id, hash_secret("fixture-token"), now(), now()])?;
        Ok(())
    }).await.unwrap();
    let spec = AuditSpec {
        user: user.clone(),
        input_record_id: Some(input),
        thread_id: thread.id.clone(),
        request_kind: "inference".to_owned(),
        model: "fixture".to_owned(),
        idx_head: input,
        idx_tail: input,
    };
    let audit_id = begin_reasoning_audit(&state, &spec).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let stream: ResponseStream =
        Box::pin(async_stream::stream! { while let Some(event) = rx.recv().await { yield event } });
    let task = tokio::spawn({
        let state = state.clone();
        async move { consume_response_events(&state, Some(&spec), Some(audit_id), stream).await }
    });
    tx.send(Ok(ResponseEvent::Created {
        response_id: Some("r".to_owned()),
    }))
    .await
    .unwrap();
    tx.send(Ok(ResponseEvent::OutputItemAdded(
        ResponseItem::from_value(
            json!({"type":"message","id":"m","role":"assistant","content":[]}),
        )
        .unwrap(),
    )))
    .await
    .unwrap();
    tx.send(Ok(ResponseEvent::OutputTextDelta {
        delta: "live text".to_owned(),
        item_id: Some("m".to_owned()),
        content_index: Some(0),
    }))
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(view) = response_for(&state, &user, thread.id.clone())
                .await
                .unwrap()
                && view
                    .response
                    .output
                    .first()
                    .is_some_and(|entry| entry.item.text() == "live text")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        history_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .len(),
        1,
        "partial deltas do not enter replay history"
    );
    tx.send(Ok(ResponseEvent::OutputItemDone(ResponseItem::from_value(json!({"type":"message","id":"m","role":"assistant","content":[{"type":"output_text","text":"final text"}]})).unwrap()))).await.unwrap();
    let tool = ResponseItem::from_value(json!({"type":"custom_tool_call","id":"ct","call_id":"custom-1","name":"bash","input":json!({"worker_id":worker_id,"command":"pwd"}).to_string()})).unwrap();
    tx.send(Ok(ResponseEvent::OutputItemDone(tool.clone())))
        .await
        .unwrap();
    let worker_call = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let value: Option<String> = user_db(&state, &user, false, |connection| {
                connection
                    .query_row(
                        "SELECT id FROM worker_calls WHERE responses_call_id='custom-1'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(ApiError::from)
            })
            .await
            .unwrap();
            if let Some(value) = value {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !task.is_finished(),
        "Worker must be queued while the SSE is still open"
    );
    let records = history_for(&state, &user, thread.id.clone()).await.unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r.kind == "response_output")
            .count(),
        2
    );
    let mut headers = HeaderMap::new();
    headers.insert("authorization", "Bearer fixture-token".parse().unwrap());
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker_id.to_owned(), worker_call)),
        headers,
        Json(WorkerResultInput {
            result: json!({"stdout":"fixture"}),
            failed: false,
            error: None,
        }),
    )
    .await
    .unwrap();
    tx.send(Ok(ResponseEvent::OutputItemDone(tool)))
        .await
        .unwrap();
    tx.send(Ok(completed("r", true))).await.unwrap();
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.output_items.len(), 2);
    assert_eq!(
        result.tool_calls.len(),
        1,
        "duplicate done must not execute twice"
    );
    let history = history_for(&state, &user, thread.id.clone()).await.unwrap();
    let output = history.iter().find(|r| r.kind == "tool_output").unwrap();
    assert_eq!(output.payload["type"], "custom_tool_call_output");
    assert_eq!(output.payload["call_id"], "custom-1");
    let replay = replayable_context_items(
        &history
            .iter()
            .map(|r| r.payload.clone())
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        replay.iter().filter(|r| r["call_id"] == "custom-1").count(),
        2
    );
    let other = user_for_subject(&state, "other-user").unwrap();
    assert!(
        response_for(&state, &other, thread.id.clone())
            .await
            .is_err()
    );
    input_record(&state, &user, &thread).await;
    assert!(
        response_for(&state, &user, thread.id.clone())
            .await
            .unwrap()
            .is_none(),
        "old request previews must not leak into the new input"
    );
    let error = enqueue_worker_call(
        &state,
        &user,
        worker_id,
        &thread.id,
        input,
        "stale".to_owned(),
        "function_call_output".to_owned(),
        "bash".to_owned(),
        json!({"worker_id":worker_id,"command":"pwd"}),
    )
    .await
    .unwrap_err();
    assert!(
        error.is_cancelled(),
        "a superseded request must not dispatch another Worker call"
    );
}

#[tokio::test]
async fn false_end_turn_continues_and_preserves_commentary_phase_in_replay() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "continuation-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (index, phase, text) in [(1, "commentary", "working"), (2, "final_answer", "done")] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            let body = json!({"id":format!("r{index}"),"end_turn":index==2,"output":[{"id":format!("m{index}"),"type":"message","role":"assistant","phase":phase,"content":[{"type":"output_text","text":text}]}]}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let integrations = IntegrationSettings {
        openai_consumer_id: "fixture".to_owned(),
        openai_consumer_secret: "fixture".to_owned(),
        openai_base_url: format!("http://{address}"),
        linkit_bot_id: String::new(),
        linkit_bot_token: String::new(),
        linkit_username: String::new(),
    };
    let (_tx, mut rx) = watch::channel(false);
    let (_, _, text) = tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &integrations, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(text, "done");
    let requests = server.await.unwrap();
    assert!(
        requests[1]["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["phase"] == "commentary" && item["content"][0]["text"] == "working")
    );
    assert_eq!(
        history_for(&state, &user, thread.id)
            .await
            .unwrap()
            .iter()
            .filter(|r| r.kind == "response_output")
            .count(),
        2
    );
}

#[tokio::test]
async fn invalid_custom_tools_are_answered_with_the_matching_output_type() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "invalid-tool-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let tool = ResponseItem::from_value(json!({"type":"custom_tool_call","id":"ct","name":"bash","call_id":"custom-id","input":"raw input without a Worker"})).unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(&state, &user, thread.id).await.unwrap();
    assert_eq!(history.last().unwrap().payload["call_id"], "custom-id");
    assert_eq!(
        history.last().unwrap().payload["type"],
        "custom_tool_call_output"
    );
    assert!(
        history.last().unwrap().payload["output"]
            .as_str()
            .unwrap()
            .contains("worker_id")
    );
}

#[tokio::test]
async fn read_context_is_answered_by_the_controller_without_a_worker_call() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "read-context-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let context_id = "00000000-0000-4000-8000-000000000099";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO contexts(id,name,description,content,parent_id) VALUES(?,?,?,?,?)",
            params![
                context_id,
                "Worker skill",
                "How to invoke the worker skill",
                r#"worker_id = "worker-1"; path = "/skill""#,
                Option::<String>::None,
            ],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-read-context",
        "call_id":"read-context-call",
        "name":"read_context",
        "arguments":json!({"context_id":context_id}).to_string()
    }))
    .unwrap();

    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(&state, &user, thread.id.clone()).await.unwrap();
    let output = history.last().unwrap();
    assert_eq!(output.kind, "tool_output");
    assert_eq!(output.payload["type"], "function_call_output");
    assert_eq!(output.payload["call_id"], "read-context-call");
    let content: Value = serde_json::from_str(output.payload["output"].as_str().unwrap()).unwrap();
    assert_eq!(content["id"], context_id);
    assert_eq!(
        content["content"],
        r#"worker_id = "worker-1"; path = "/skill""#
    );
    let worker_calls: i64 = user_db(&state, &user, false, |connection| {
        connection
            .query_row("SELECT COUNT(*) FROM worker_calls", [], |row| row.get(0))
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    assert_eq!(worker_calls, 0);
}

#[tokio::test]
async fn additive_schema_upgrade_preserves_existing_history() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "migration-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    user_db(&state, &user, false, move |connection| {
        connection.execute_batch("DROP TABLE response_states; ALTER TABLE worker_calls DROP COLUMN responses_output_type;")?;
        ensure_user_schema(connection)?;
        let id: i64 = connection.query_row("SELECT id FROM history_records", [], |row| row.get(0))?;
        assert_eq!(id, input);
        Ok(())
    }).await.unwrap();
}

#[tokio::test]
async fn superseded_worker_callback_is_stored_once_outside_the_protocol_context() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "late-worker-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let first = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000002";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,last_seen_at,status) VALUES(?,'fixture',?,?,?,'online')",
            params![worker_id, hash_secret("fixture-token"), now(), now()],
        )?;
        Ok(())
    }).await.unwrap();
    let call_id = enqueue_worker_call(
        &state,
        &user,
        worker_id,
        &thread.id,
        first,
        "old-call".to_owned(),
        "function_call_output".to_owned(),
        "bash".to_owned(),
        json!({"worker_id":worker_id,"command":"pwd"}),
    )
    .await
    .unwrap();
    let second = input_record(&state, &user, &thread).await;
    cancel_worker_call(&state, &user, &call_id).await;
    for _ in 0..2 {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer fixture-token".parse().unwrap());
        let _ = worker_result(
            State(state.clone()),
            AxumPath((user.id.clone(), worker_id.to_owned(), call_id.clone())),
            headers,
            Json(WorkerResultInput {
                result: json!({"stdout":"late result"}),
                failed: false,
                error: None,
            }),
        )
        .await
        .unwrap();
    }
    let history = history_for(&state, &user, thread.id.clone()).await.unwrap();
    assert_eq!(history.len(), 3);
    assert_eq!(history[2].kind, "activity");
    assert_eq!(history[2].payload["call_id"], "old-call");
    assert!(
        history[2].payload["output"]
            .as_str()
            .unwrap()
            .contains("late result")
    );
    user_db(&state, &user, false, move |connection| {
        let (status, output_id): (String, i64) = connection.query_row(
            "SELECT status,output_record_id FROM worker_calls WHERE id=?",
            [call_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(status, "failed");
        assert_eq!(output_id, history[2].id);
        let context = compile_thread_context(connection, &thread.id, second)?;
        assert_eq!(context.record_ids, [first, second]);
        assert!(
            context
                .items
                .iter()
                .all(|item| item.get("call_id").is_none())
        );
        Ok(())
    })
    .await
    .unwrap();
}
