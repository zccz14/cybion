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
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker_id.to_owned(), worker_call)),
        axum::Extension(user.clone()),
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

async fn read_context_tool_output(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    input: i64,
    context_id: &str,
) -> Value {
    let call_id = format!("read-{context_id}");
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":format!("fc-{context_id}"),
        "call_id":call_id,
        "name":"read_context",
        "arguments":json!({"context_id":context_id}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(state, user, thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(state, user, thread.id.clone()).await.unwrap();
    let output = history.last().unwrap();
    assert_eq!(output.kind, "tool_output");
    assert_eq!(output.payload["type"], "function_call_output");
    assert_eq!(output.payload["call_id"], call_id);
    serde_json::from_str(output.payload["output"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn read_context_discovers_direct_children_and_reads_further_levels_without_workers() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "read-context-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let parent = "00000000-0000-4000-8000-000000000099";
    let child_z = "00000000-0000-4000-8000-000000000100";
    let child_a = "00000000-0000-4000-8000-000000000101";
    let child_b = "00000000-0000-4000-8000-000000000102";
    let grandchild = "00000000-0000-4000-8000-000000000103";
    let unrelated = "00000000-0000-4000-8000-000000000104";
    user_db(&state, &user, false, move |connection| {
        for (id, name, content, parent_id) in [
            (
                parent,
                "Root",
                "Cybion user-authored content is preserved",
                None,
            ),
            (child_z, "Zulu", "child Z content", Some(parent)),
            (child_b, "Alpha", "child B content", Some(parent)),
            (child_a, "Alpha", "child A content", Some(parent)),
            (
                grandchild,
                "Grandchild",
                "grandchild content",
                Some(child_a),
            ),
            (unrelated, "Unrelated", "unrelated content", None),
        ] {
            connection.execute(
                "INSERT INTO contexts(id,name,description,content,parent_id) VALUES(?,?,?,?,?)",
                params![id, name, format!("Metadata for {name}"), content, parent_id],
            )?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let content = read_context_tool_output(&state, &user, &thread, input, parent).await;
    assert_eq!(
        content,
        json!({
            "id":parent,
            "name":"Root",
            "description":"Metadata for Root",
            "content":"Cybion user-authored content is preserved",
            "parent_id":null,
            "children":[
                {"context_id":child_a,"name":"Alpha","description":"Metadata for Alpha"},
                {"context_id":child_b,"name":"Alpha","description":"Metadata for Alpha"},
                {"context_id":child_z,"name":"Zulu","description":"Metadata for Zulu"}
            ]
        })
    );
    let Json(api_content) = read_context_api(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: user.clone(),
            bearer: String::new(),
        }),
        AxumPath(parent.to_owned()),
    )
    .await
    .unwrap();
    assert_eq!(serde_json::to_value(api_content).unwrap(), content);
    let child = read_context_tool_output(
        &state,
        &user,
        &thread,
        input,
        content["children"][0]["context_id"].as_str().unwrap(),
    )
    .await;
    assert_eq!(child["id"], child_a);
    assert_eq!(child["parent_id"], parent);
    assert_eq!(child["content"], "child A content");
    assert_eq!(
        child["children"],
        json!([
            {"context_id":grandchild,"name":"Grandchild","description":"Metadata for Grandchild"}
        ])
    );
    let leaf = read_context_tool_output(
        &state,
        &user,
        &thread,
        input,
        child["children"][0]["context_id"].as_str().unwrap(),
    )
    .await;
    assert_eq!(leaf["id"], grandchild);
    assert_eq!(leaf["content"], "grandchild content");
    assert_eq!(leaf["children"], json!([]));
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
async fn read_context_cannot_disclose_another_users_nodes() {
    let (_root, state) = test_state();
    let owner = user_for_subject(&state, "context-owner").unwrap();
    let other = user_for_subject(&state, "context-other").unwrap();
    let thread = create_test_thread(&state, &other).await;
    let input = input_record(&state, &other, &thread).await;
    let foreign = "00000000-0000-4000-8000-000000000099";
    user_db(&state, &owner, true, move |connection| {
        connection.execute(
            "INSERT INTO contexts(id,name,description,content) VALUES(?,'Private','Private description','Private content')",
            [foreign],
        )?;
        Ok(())
    }).await.unwrap();
    for id in [foreign, "00000000-0000-4000-8000-000000000098"] {
        let output = read_context_tool_output(&state, &other, &thread, input, id).await;
        assert_eq!(output, json!({"error":"context not found"}));
    }
    let output = read_context_tool_output(&state, &other, &thread, input, "invalid-id").await;
    assert!(output["error"].is_string());
    assert!(output.get("children").is_none());
}

#[tokio::test]
async fn offline_worker_calls_are_answered_without_queueing_execution() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "offline-worker-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let workers = [
        (
            "00000000-0000-4000-8000-000000000091",
            "offline",
            Some(now()),
        ),
        (
            "00000000-0000-4000-8000-000000000092",
            "online",
            Some(now() - WORKER_ONLINE_SECONDS - 100),
        ),
        ("00000000-0000-4000-8000-000000000093", "offline", None),
    ];
    user_db(&state, &user, false, move |connection| {
        for (id, status, last_seen) in workers {
            connection.execute(
                "INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,'fixture',?,1,?,?)",
                params![id, id, status, last_seen],
            )?;
        }
        Ok(())
    }).await.unwrap();
    for (id, _, _) in workers {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call", "id":format!("fc-{id}"), "call_id":id, "name":"bash",
            "arguments":json!({"worker_id":id,"command":"echo must-not-run"}).to_string()
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
        assert_eq!(output.payload["call_id"], id);
        assert_eq!(
            serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
            json!({"error":"selected Worker is offline"})
        );
    }
    let count: i64 = user_db(&state, &user, false, |connection| {
        connection
            .query_row("SELECT COUNT(*) FROM worker_calls", [], |row| row.get(0))
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn inference_keeps_prefix_and_tools_when_the_last_online_worker_disconnects() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "worker-prefix-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000001";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,'Laptop',?,1,'online',?)",
            params![worker_id, worker_id, now()],
        )?;
        Ok(())
    }).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_user = user.clone();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for index in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            user_db(&server_state, &server_user, false, |connection| {
                connection.execute(
                    "UPDATE workers SET status='offline',last_seen_at=NULL,resource_json='{}'",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap();
            let body = json!({
                "id":format!("r{index}"), "end_turn":index == 1,
                "output":[{"type":"message","id":format!("m{index}"),"role":"assistant","content":[{"type":"output_text","text":"done"}]}]
            }).to_string();
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
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
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &integrations, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = server.await.unwrap();
    assert!(
        requests[0]["input"][0]["content"]
            .as_str()
            .unwrap()
            .contains(worker_id)
    );
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 6);
    for key in ["tools", "tool_choice"] {
        assert_eq!(
            serde_json::to_vec(&requests[0][key]).unwrap(),
            serde_json::to_vec(&requests[1][key]).unwrap()
        );
    }
    assert_eq!(
        serde_json::to_vec(&requests[0]["input"][0]).unwrap(),
        serde_json::to_vec(&requests[1]["input"][0]).unwrap()
    );
}

#[tokio::test]
async fn failed_worker_result_is_returned_as_a_tool_result_for_continuation() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "failed-worker-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000003";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status) VALUES(?,'fixture',?,?, 'online')",
            params![worker_id, hash_secret("fixture-token"), now()],
        )?;
        connection.execute(
            "INSERT INTO worker_calls(
                id,responses_call_id,worker_id,thread_id,input_record_id,name,arguments_json,status,
                result_json,created_at,error
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![
                "failed-call",
                "responses-call",
                worker_id,
                &thread.id,
                input,
                "bash",
                r#"{"worker_id":"worker","command":"false"}"#,
                "failed",
                r#"{"error":"command exited with status 1"}"#,
                now(),
                "command exited with status 1",
            ],
        )?;
        Ok(())
    })
    .await
    .unwrap();

    let (_tx, mut cancellation) = watch::channel(false);
    let (result, output_record_id) =
        wait_worker_result(&state, &user, "failed-call", &mut cancellation)
            .await
            .unwrap();
    assert_eq!(result["error"], "command exited with status 1");
    assert!(output_record_id.is_none());
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
        let _ = worker_result(
            State(state.clone()),
            AxumPath((user.id.clone(), worker_id.to_owned(), call_id.clone())),
            axum::Extension(user.clone()),
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
