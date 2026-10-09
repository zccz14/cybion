use super::tests::{
    bind_thread_upstream, create_test_thread, insert_record, insert_upstream, read_http_request,
    read_json_request, test_state,
};
use super::*;
use crate::responses::{ResponseCompleted, ResponseEvent};
use tokio::io::AsyncWriteExt;

async fn input_record(state: &AppState, user: &User, thread: &ThreadView) -> i64 {
    let id = thread.id.clone();
    user_db(state, user, false, move |connection| {
        connection.execute("UPDATE threads SET status='running' WHERE id=?", [&id])?;
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

/// An input record whose message carries the given image data URLs, the shape
/// the composer produces for pasted pictures.
async fn input_record_with_images(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    images: &[&str],
) -> i64 {
    let id = thread.id.clone();
    let mut content = vec![json!({"type":"input_text","text":"make variants"})];
    for image in images {
        content.push(json!({"type":"input_image","image_url":image}));
    }
    user_db(state, user, false, move |connection| {
        connection.execute("UPDATE threads SET status='running' WHERE id=?", [&id])?;
        Ok(insert_record(
            connection,
            &id,
            "input",
            json!({"role":"user","content":content}),
        ))
    })
    .await
    .unwrap()
}

/// Sets the per-thread image generation model; an empty string disables the
/// tool for the Thread even when the account default enables it.
async fn set_thread_image_generation_model(
    state: &AppState,
    user: &User,
    thread_id: &str,
    model: &str,
) {
    let thread_id = thread_id.to_owned();
    let model = model.to_owned();
    user_db(state, user, false, move |connection| {
        connection.execute(
            "UPDATE threads SET image_generation_model=? WHERE id=?",
            params![model, thread_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

/// Sets the account default image generation model that Threads without an
/// override follow.
async fn set_default_image_generation_model(state: &AppState, user: &User, model: &str) {
    let model = model.to_owned();
    user_db(state, user, false, move |connection| {
        connection.execute(
            "INSERT INTO thread_defaults(id,model,upstream_id,reasoning_effort,service_tier_fast,context_budget_tokens,minimal_mode,image_generation_model)
             VALUES(1,'fixture-model',NULL,'medium',0,200000,0,?)
             ON CONFLICT(id) DO UPDATE SET image_generation_model=excluded.image_generation_model",
            params![model],
        )?;
        Ok(())
    })
    .await
    .unwrap();
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
        reasoning_effort: Some("high".to_owned()),
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
        history_for(&state, &user, thread.id.clone(), 0)
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
    let records = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r.kind == "response_output")
            .count(),
        2
    );
    user_db(&state, &user, false, move |c| {
        assert!(worker_protocol::claim(c, worker_id, None)?.is_some());
        Ok(())
    })
    .await
    .unwrap();
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
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
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
    let recorded: Option<String> = user_db(&state, &user, false, move |connection| {
        connection
            .query_row(
                "SELECT reasoning_effort FROM reasoning_audits WHERE id=?",
                [audit_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    assert_eq!(recorded.as_deref(), Some("high"));
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
    let upstream = Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: format!("http://{address}"),
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
        history_for(&state, &user, thread.id, 0)
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
    let history = history_for(&state, &user, thread.id, 0).await.unwrap();
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

async fn tool_output(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    input: i64,
    call_id: &str,
    name: &str,
    arguments: Value,
) -> Value {
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":format!("fc-{call_id}"),
        "call_id":call_id,
        "name":name,
        "arguments":arguments.to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(state, user, thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(state, user, thread.id.clone(), 0)
        .await
        .unwrap();
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
    let content = tool_output(
        &state,
        &user,
        &thread,
        input,
        "read-root",
        "read_context",
        json!({"context_id": parent}),
    )
    .await;
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
    let child = tool_output(
        &state,
        &user,
        &thread,
        input,
        "read-child",
        "read_context",
        json!({"context_id": content["children"][0]["context_id"].as_str().unwrap()}),
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
    let leaf = tool_output(
        &state,
        &user,
        &thread,
        input,
        "read-leaf",
        "read_context",
        json!({"context_id": child["children"][0]["context_id"].as_str().unwrap()}),
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
        let output = tool_output(
            &state,
            &other,
            &thread,
            input,
            &format!("read-{id}"),
            "read_context",
            json!({"context_id": id}),
        )
        .await;
        assert_eq!(
            output,
            json!({"error":"context not found (the CTX integration is not connected)"})
        );
    }
    let output = tool_output(
        &state,
        &other,
        &thread,
        input,
        "read-invalid",
        "read_context",
        json!({"context_id": "invalid-id"}),
    )
    .await;
    assert!(output["error"].is_string());
    assert!(output.get("children").is_none());
}

#[tokio::test]
async fn registry_tools_list_top_level_contexts_and_registered_workers() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "registry-tool-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let parent = "00000000-0000-4000-8000-0000000000b0";
    let child = "00000000-0000-4000-8000-0000000000b1";
    user_db(&state, &user, true, move |connection| {
        connection.execute(
            "INSERT INTO contexts(id,name,description,content) VALUES(?,?,?,?)",
            params![
                parent,
                "Skills",
                "Reusable worker skills",
                "top-secret parent content"
            ],
        )?;
        connection.execute(
            "INSERT INTO contexts(id,name,description,content,parent_id) VALUES(?,?,?,?,?)",
            params![
                child,
                "Bash skill",
                "Run bash",
                "worker_id = 'worker'; path = '/skill'",
                parent
            ],
        )?;
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at) VALUES('worker-z','Zulu','worker-z',1)",
            [],
        )?;
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at) VALUES('worker-a','Alpha','worker-a',1)",
            [],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let contexts = tool_output(
        &state,
        &user,
        &thread,
        input,
        "list-contexts",
        "cybion_list_contexts",
        json!({}),
    )
    .await;
    assert_eq!(
        contexts,
        json!({"contexts":[{"context_id":parent,"name":"Skills","description":"Reusable worker skills"}]})
    );
    let workers = tool_output(
        &state,
        &user,
        &thread,
        input,
        "list-workers",
        "cybion_list_workers",
        json!({}),
    )
    .await;
    assert_eq!(
        workers,
        json!({"workers":[{"worker_id":"worker-a","label":"Alpha","owner_user_id":"registry-tool-user","access":"owner"},{"worker_id":"worker-z","label":"Zulu","owner_user_id":"registry-tool-user","access":"owner"}]})
    );
}

async fn seed_delayed_call(state: &AppState, user: &User, thread: &ThreadView, seconds: u64) {
    let thread_id = thread.id.clone();
    user_db(state, user, false, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type":"function_call","id":"fc-delay","call_id":"delay-1","name":"bash",
                "arguments": json!({"worker_id":"00000000-0000-4000-8000-000000000051","command":"run-after-wait","delay_seconds":seconds}).to_string()
            }),
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn delayed_worker_calls_wait_in_the_controller_before_dispatch() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "delay-stream-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000051";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,last_seen_at,status) VALUES(?,'fixture',?,?,?,'online')",
            params![worker_id, hash_secret("fixture-token"), now(), now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let spec = AuditSpec {
        user: user.clone(),
        input_record_id: Some(input),
        thread_id: thread.id.clone(),
        request_kind: "inference".to_owned(),
        model: "fixture".to_owned(),
        reasoning_effort: Some("high".to_owned()),
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
    tx.send(Ok(ResponseEvent::OutputItemDone(
        ResponseItem::from_value(json!({
            "type":"function_call","id":"fc-delay","call_id":"delay-1","name":"bash",
            "arguments": json!({"worker_id":worker_id,"command":"run-after-wait","delay_seconds":86400}).to_string()
        }))
        .unwrap(),
    )))
    .await
    .unwrap();
    tx.send(Ok(completed("r", true))).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .expect("a delayed Worker call must not block the response stream")
        .unwrap()
        .unwrap();
    assert!(matches!(
        result.tool_calls.as_slice(),
        [PendingToolCall::WorkerDelayed {
            seconds: 86_400,
            ..
        }]
    ));
    let count: i64 = user_db(&state, &user, false, |connection| {
        connection
            .query_row("SELECT COUNT(*) FROM worker_calls", [], |row| row.get(0))
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "a delayed call is not dispatched while the response streams"
    );
}

#[tokio::test]
async fn delayed_worker_call_dispatches_after_the_controller_wait() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "delay-settle-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000051";
    user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            connection.execute(
                "INSERT INTO workers(id,label,token_hash,created_at,last_seen_at,status) VALUES(?,'fixture',?,?,?,'online')",
                params![worker_id, hash_secret("fixture-token"), now(), now()],
            )?;
            insert_record(
                connection,
                &thread_id,
                "response_output",
                json!({
                    "type":"function_call","id":"fc-delay","call_id":"delay-1","name":"bash",
                    "arguments": json!({"worker_id":worker_id,"command":"run-after-wait","delay_seconds":1}).to_string()
                }),
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let start = now();
    let (_tx, mut cancellation) = tokio::sync::watch::channel(false);
    let task = tokio::spawn({
        let state = state.clone();
        let user = user.clone();
        let thread = thread.clone();
        async move { recovery::settle_tools(&state, &user, &thread, input, &mut cancellation).await }
    });
    let call_id = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let id: Option<String> = user_db(&state, &user, false, |connection| {
                connection
                    .query_row("SELECT id FROM worker_calls LIMIT 1", [], |row| row.get(0))
                    .optional()
                    .map_err(ApiError::from)
            })
            .await
            .unwrap();
            if let Some(id) = id {
                break id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a delayed call must dispatch after the wait");
    let created_at: i64 = user_db(&state, &user, false, {
        let id = call_id.clone();
        move |connection| {
            connection
                .query_row(
                    "SELECT created_at FROM worker_calls WHERE id=?",
                    [id],
                    |row| row.get(0),
                )
                .map_err(ApiError::from)
        }
    })
    .await
    .unwrap();
    assert!(
        created_at - start >= 1,
        "the Worker call is created only after the controller wait"
    );
    user_db(&state, &user, false, move |c| {
        assert!(worker_protocol::claim(c, worker_id, None)?.is_some());
        Ok(())
    })
    .await
    .unwrap();
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker_id.to_owned(), call_id)),
        axum::Extension(user.clone()),
        Json(WorkerResultInput {
            result: json!({"stdout":"delayed-ok"}),
            failed: false,
            error: None,
        }),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("settlement must finish after the Worker result")
        .unwrap()
        .unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = history.iter().find(|r| r.kind == "tool_output").unwrap();
    assert_eq!(output.payload["call_id"], "delay-1");
    assert_eq!(
        serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
        json!({"stdout":"delayed-ok"})
    );
}

#[tokio::test]
async fn delayed_worker_calls_stop_when_the_thread_cancels() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "delay-cancel-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    seed_delayed_call(&state, &user, &thread, 86_400).await;
    let (tx, mut cancellation) = tokio::sync::watch::channel(false);
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send(true).unwrap();
    };
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        let (result, ()) = tokio::join!(
            recovery::settle_tools(&state, &user, &thread, input, &mut cancellation),
            cancel
        );
        result
    })
    .await
    .expect("a cancelled delay must stop promptly");
    assert!(result.unwrap_err().is_cancelled());
    let count: i64 = user_db(&state, &user, false, |connection| {
        connection
            .query_row("SELECT COUNT(*) FROM worker_calls", [], |row| row.get(0))
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "a cancelled delay must not dispatch the Worker call"
    );
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
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
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
async fn inference_keeps_worker_tools_when_the_last_online_worker_disconnects() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "worker-tools-user").unwrap();
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
    let upstream = Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: format!("http://{address}"),
        api_key: "fixture".to_owned(),
    };
    let (_tx, mut rx) = watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = server.await.unwrap();
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 7);
    let names = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"bash"));
    assert!(!names.contains(&"normai_image_generation"));
    for key in ["tools", "tool_choice"] {
        assert_eq!(
            serde_json::to_vec(&requests[0][key]).unwrap(),
            serde_json::to_vec(&requests[1][key]).unwrap()
        );
    }
}

#[tokio::test]
async fn inference_injects_web_search_and_the_configured_image_tool() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "tool-switch-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let worker_id = "00000000-0000-4000-8000-000000000001";
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,'Laptop',?,1,'online',?)",
            params![worker_id, worker_id, now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for index in 0..1 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            let body = json!({
                "id":format!("r{index}"), "end_turn":true,
                "output":[{"type":"message","id":format!("m{index}"),"role":"assistant","content":[{"type":"output_text","text":"done"}]}]
            }).to_string();
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
        requests
    });
    let upstream = Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: format!("http://{address}"),
        api_key: "fixture".to_owned(),
    };
    let input = input_record(&state, &user, &thread).await;
    let (_tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = server.await.unwrap();
    let names = |request: &Value| {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        names(&requests[0]),
        [
            "cybion_list_contexts",
            "cybion_list_workers",
            "read_context",
            "bash",
            "browser_control",
            "computer_use",
            "normai_web_search",
            "normai_image_generation"
        ]
    );
    let web_search = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "normai_web_search")
        .unwrap();
    assert_eq!(web_search["type"], "function");
    assert_eq!(web_search["parameters"]["required"], json!(["query"]));
    let image = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "normai_image_generation")
        .unwrap();
    assert_eq!(image["type"], "function");
    assert_eq!(image["parameters"]["required"], json!(["prompt"]));
    for request in &requests {
        assert_eq!(request["tool_choice"], "auto");
    }
}

#[tokio::test]
async fn inference_offers_the_image_tool_only_with_a_configured_image_model() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-tool-switch-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for index in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            let body = json!({
                "id":format!("r{index}"), "end_turn":true,
                "output":[{"type":"message","id":format!("m{index}"),"role":"assistant","content":[{"type":"output_text","text":"done"}]}]
            }).to_string();
            socket.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
        requests
    });
    let upstream = Upstream {
        id: "fixture-upstream".to_owned(),
        name: "fixture".to_owned(),
        base_url: format!("http://{address}"),
        api_key: "fixture".to_owned(),
    };
    let names = |request: &Value| {
        request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    };
    // Without a configuration the tool stays out of the request.
    let input = input_record(&state, &user, &thread).await;
    let (_tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    // The account default turns it on for Threads without an override.
    set_default_image_generation_model(&state, &user, "gpt-image-2").await;
    let input = input_record(&state, &user, &thread).await;
    let (_tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    // An explicit empty override disables it again even with the default set.
    set_thread_image_generation_model(&state, &user, &thread.id, "").await;
    let input = input_record(&state, &user, &thread).await;
    let (_tx, mut rx) = tokio::sync::watch::channel(false);
    tokio::time::timeout(
        Duration::from_secs(5),
        request_agent(&state, &user, &thread, &upstream, input, &mut rx),
    )
    .await
    .unwrap()
    .unwrap();
    let requests = server.await.unwrap();
    assert!(
        !names(&requests[0])
            .iter()
            .any(|name| name == "normai_image_generation")
    );
    assert!(
        names(&requests[1])
            .iter()
            .any(|name| name == "normai_image_generation")
    );
    assert!(
        !names(&requests[2])
            .iter()
            .any(|name| name == "normai_image_generation")
    );
}

#[tokio::test]
async fn failed_and_cancelled_worker_results_are_returned_for_continuation() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "failed-worker-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let worker_id = "00000000-0000-4000-8000-000000000003";
    let thread_id = thread.id.clone();
    let fixture_thread = thread_id.clone();
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
                &fixture_thread,
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
    let fixture_thread = thread_id.clone();
    user_db(&state, &user, false, move |connection| {
        connection.execute(
            "INSERT INTO worker_calls(id,worker_id,thread_id,input_record_id,name,arguments_json,status,created_at,error)
             VALUES('cancelled-call',?1,?2,?3,'bash','{}','cancelled',?4,'request superseded by a newer input')",
            params![worker_id, fixture_thread, input, now()],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let (result, output_record_id) =
        wait_worker_result(&state, &user, "cancelled-call", &mut cancellation)
            .await
            .unwrap();
    assert_eq!(result["error"], "request superseded by a newer input");
    assert!(output_record_id.is_none());
}

#[tokio::test]
async fn additive_schema_upgrade_preserves_existing_history() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "migration-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    user_db(&state, &user, false, move |connection| {
        schema_tests::remove_sharing_fixture(connection);
        connection.execute_batch("DROP TABLE response_states; ALTER TABLE worker_calls DROP COLUMN responses_output_type; PRAGMA user_version=21;")?;
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
    user_db(&state, &user, false, move |c| {
        assert!(worker_protocol::claim(c, worker_id, None)?.is_some());
        Ok(())
    })
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
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
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
        assert_eq!(status, "cancelled");
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

#[tokio::test]
async fn thread_titles_replay_the_thread_context_and_leave_reasoning_headroom() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "title-generation-user").unwrap();
    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    let thread = create_thread_for(
        &state,
        &user,
        CreateThreadInput {
            title: None,
            external_ref: None,
            model: Some("test-model".to_owned()),
            upstream_id: Some(upstream.id),
            reasoning_effort: None,
            service_tier_fast: None,
        },
        ThreadOrigin::Web,
    )
    .await
    .unwrap();
    user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role": "user", "content": "fix the flaky title generation"}),
            );
            Ok(insert_record(
                connection,
                &thread_id,
                "activity",
                json!({"type": "thread_control", "action": "continue"}),
            ))
        }
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_json_request(&mut socket).await;
        let body = json!({"id":"r1","end_turn":true,"output":[{"id":"m1","type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Flaky Thread Titles"}]}]}).to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        request
    });
    let upstream = insert_upstream(&state, &user, "fixture", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let named = maybe_name_thread(&state, &user, &thread).await;
    assert_eq!(named.title, "Flaky Thread Titles");
    let request = server.await.unwrap();
    assert!(request.get("max_output_tokens").is_none());
    let input = request["input"].as_array().unwrap();
    assert_eq!(
        input[0]["content"], "fix the flaky title generation",
        "title requests must start with the replayed conversation: {request}"
    );
    let instruction = input.last().unwrap();
    assert_eq!(instruction["role"], "user");
    assert!(
        instruction["content"]
            .as_str()
            .unwrap()
            .contains("concise title"),
        "the title instruction must close the request: {request}"
    );
    assert!(
        input
            .iter()
            .any(|item| item["content"] == "fix the flaky title generation"),
        "the title request must replay the thread context: {request}"
    );
    let stored: String = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            Ok(connection.query_row(
                "SELECT title FROM threads WHERE id=?",
                [&thread_id],
                |row| row.get(0),
            )?)
        }
    })
    .await
    .unwrap();
    assert_eq!(stored, "Flaky Thread Titles");
}

#[tokio::test]
async fn manual_title_generation_replays_the_thread_context_and_overwrites_the_title() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "context-title-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role": "user", "content": "first question"}),
            );
            insert_record(
                connection,
                &thread_id,
                "response_output",
                json!({"type": "message", "id": "m1", "role": "assistant", "content": [{"type": "output_text", "text": "first answer"}]}),
            );
            Ok(insert_record(
                connection,
                &thread_id,
                "input",
                json!({"role": "user", "content": "second question"}),
            ))
        }
    })
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_json_request(&mut socket).await;
        let body = json!({"id":"r1","end_turn":true,"output":[{"id":"m2","type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Context Title"}]}]}).to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        request
    });
    let upstream = insert_upstream(&state, &user, "fixture", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    let titled = generate_thread_title_for(&state, &user, thread.id.clone())
        .await
        .unwrap();
    assert_eq!(titled.title, "Context Title");
    let request = server.await.unwrap();
    let input = request["input"].as_array().unwrap();
    assert_eq!(
        input[0]["content"], "first question",
        "title requests must start with the replayed conversation: {request}"
    );
    assert!(
        input.iter().any(|item| item["content"] == "first question")
            && input
                .iter()
                .any(|item| item["content"] == "second question"),
        "title requests must replay the whole conversation: {request}"
    );
    let instruction = input.last().unwrap();
    assert_eq!(instruction["role"], "user");
    assert!(
        instruction["content"]
            .as_str()
            .unwrap()
            .contains("concise title"),
        "the title instruction must close the request: {request}"
    );
    assert!(request.get("max_output_tokens").is_none());
    let stored: String = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |connection| {
            Ok(connection.query_row(
                "SELECT title FROM threads WHERE id=?",
                [&thread_id],
                |row| row.get(0),
            )?)
        }
    })
    .await
    .unwrap();
    assert_eq!(stored, "Context Title");
}

#[test]
fn replayed_tool_calls_regroup_before_their_outputs_within_a_thinking_turn() {
    let items = vec![
        json!({"type":"reasoning","id":"rs-1","summary":[],"content":[{"type":"reasoning_text","text":"plan"}]}),
        json!({"type":"message","id":"msg-1","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"reading"}]}),
        json!({"type":"function_call","id":"fc-1","name":"browser_control","call_id":"call-a","arguments":"{\"action\":\"html\"}"}),
        json!({"type":"function_call_output","call_id":"call-a","output":"{\"error\":\"unsupported browser action: html\"}"}),
        json!({"type":"function_call","id":"fc-2","name":"bash","call_id":"call-b","arguments":"{\"command\":\"curl\"}"}),
        json!({"type":"function_call_output","call_id":"call-b","output":"{\"stdout\":\"ok\"}"}),
    ];
    let replay = replayable_context_items(&items);
    assert_eq!(replay[0]["type"], "reasoning");
    assert_eq!(replay[1]["type"], "message");
    assert_eq!(replay.len(), 6);
    let position = |call_id: &str, output: bool| {
        replay
            .iter()
            .position(|item| {
                item["call_id"] == call_id
                    && matches!(tool_pair(item), Some((_, item_output)) if item_output == output)
            })
            .unwrap()
    };
    assert!(position("call-a", false) < position("call-b", false));
    assert!(
        position("call-b", false) < position("call-a", true),
        "a call must move before outputs that settled while its response streamed"
    );
    assert!(position("call-a", true) < position("call-b", true));
}

#[test]
fn replayed_tool_items_stay_paired_with_outputs_after_the_call() {
    let items = vec![
        json!({"type":"reasoning","id":"rs-1","summary":[]}),
        json!({"type":"function_call","id":"fc-1","name":"bash","call_id":"call-a","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-a","output":"{}"}),
        json!({"type":"function_call","id":"fc-orphan","name":"bash","call_id":"call-b","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-c","output":"{}"}),
        json!({"type":"function_call","id":"fc-dup-1","name":"bash","call_id":"call-d","arguments":"{}"}),
        json!({"type":"function_call","id":"fc-dup-2","name":"bash","call_id":"call-d","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-d","output":"{}"}),
    ];
    let replay = replayable_context_items(&items);
    for (index, item) in replay.iter().enumerate() {
        let Some((_, false)) = tool_pair(item) else {
            continue;
        };
        let id = item["call_id"].as_str().unwrap();
        let outputs = replay
            .iter()
            .enumerate()
            .filter(|(_, other)| {
                matches!(tool_pair(other), Some((_, true))) && other["call_id"] == id
            })
            .map(|(output_index, _)| output_index)
            .collect::<Vec<_>>();
        assert_eq!(
            outputs.len(),
            1,
            "each kept call must pair with exactly one output"
        );
        assert!(outputs[0] > index, "every output must stay after its call");
    }
    assert!(
        !replay.iter().any(|item| matches!(
            item["call_id"].as_str(),
            Some("call-b" | "call-c" | "call-d")
        )),
        "orphaned and duplicated tool pairs must stay dropped"
    );
}

#[test]
fn replayed_tool_calls_without_reasoning_group_before_their_outputs() {
    let items = vec![
        json!({"role":"user","content":"hello"}),
        json!({"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"working"}]}),
        json!({"type":"function_call","id":"fc-1","name":"bash","call_id":"call-a","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-a","output":"{}"}),
        json!({"type":"function_call","id":"fc-2","name":"bash","call_id":"call-b","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-b","output":"{}"}),
    ];
    let replay = replayable_context_items(&items);
    let call_ids = replay
        .iter()
        .map(|item| item["call_id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        call_ids,
        vec!["", "", "call-a", "call-b", "call-a", "call-b"]
    );
}

#[test]
fn replayed_tool_calls_move_messages_out_of_the_pending_batch() {
    // A message can stream between a call and its still-running output while
    // the response that made the call is streaming. Strict Responses
    // validators (DeepSeek) reject any request that carries a non-output item
    // while a call is unanswered, naming that call, so the message must move
    // ahead of the call batch.
    let items = vec![
        json!({"role":"user","content":"hello"}),
        json!({"type":"function_call","id":"fc-1","name":"bash","call_id":"call-a","arguments":"{}"}),
        json!({"type":"message","id":"msg-1","role":"assistant","content":[{"type":"output_text","text":"next"}]}),
        json!({"type":"function_call","id":"fc-2","name":"bash","call_id":"call-b","arguments":"{}"}),
        json!({"type":"function_call_output","call_id":"call-a","output":"{}"}),
        json!({"type":"function_call_output","call_id":"call-b","output":"{}"}),
    ];
    let replay = replayable_context_items(&items);
    let call_ids = replay
        .iter()
        .map(|item| item["call_id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        call_ids,
        vec!["", "", "call-a", "call-b", "call-a", "call-b"]
    );
}

#[tokio::test]
async fn image_generation_calls_the_upstream_image_endpoint_and_attaches_the_image() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, request) = read_http_request(&mut socket).await;
        let body = json!({"data":[{"b64_json":"iVBORw0KGgo","revised_prompt":"A red circle."}]})
            .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        (headers, request)
    });
    let upstream = insert_upstream(&state, &user, "images", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-image",
        "call_id":"call-image",
        "name":"normai_image_generation",
        "arguments": json!({"prompt":"A red circle on a white background."}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let (headers, request) = server.await.unwrap();
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case("authorization: Bearer sk-fixture"))
    );
    let expected_user_agent = format!("user-agent: cybion/{}", env!("CARGO_PKG_VERSION"));
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case(&expected_user_agent))
    );
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case("originator: cybion"))
    );
    assert_eq!(
        request,
        json!({"model":"gpt-image-2","prompt":"A red circle on a white background."})
    );
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = &history[history.len() - 2];
    assert_eq!(output.kind, "tool_output");
    assert_eq!(output.payload["type"], "function_call_output");
    assert_eq!(output.payload["call_id"], "call-image");
    assert_eq!(
        serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
        json!({"status":"completed","revised_prompt":"A red circle."})
    );
    let image = &history[history.len() - 1];
    assert_eq!(image.kind, "tool_output");
    assert_eq!(image.payload["type"], "image_generation_call");
    assert_eq!(image.payload["status"], "completed");
    assert_eq!(image.payload["result"], "iVBORw0KGgo");
    assert_eq!(image.payload["output_format"], "png");
    // The settled call and its image replay together as one turn.
    let items = vec![tool.value(), output.payload.clone(), image.payload.clone()];
    assert_eq!(replayable_context_items(&items).len(), 3);
}

#[tokio::test]
async fn image_generation_without_a_configured_model_is_answered_to_the_model() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-disabled-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    // No upstream fixture: a disabled model must be answered without any
    // image request leaving the controller (the thread upstream is
    // unreachable, so an attempted call would surface a different error).
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-image",
        "call_id":"call-image",
        "name":"normai_image_generation",
        "arguments": json!({"prompt":"A red circle."}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = history.last().unwrap();
    assert_eq!(output.payload["type"], "function_call_output");
    assert_eq!(
        serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
        json!({"error":"image generation is disabled for this thread"})
    );
}

#[tokio::test]
async fn image_generation_failures_are_answered_to_the_model() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-failure-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in [
            (
                "400 Bad Request",
                "{\"error\":{\"message\":\"model_not_priced\"}}",
            ),
            (
                "502 Bad Gateway",
                "{\"error\":{\"message\":\"image generation failed\"}}",
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        requests
    });
    let upstream = insert_upstream(&state, &user, "images", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    set_default_image_generation_model(&state, &user, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    for (call_id, expected) in [
        ("call-rejected", "image generation was rejected (HTTP 400)"),
        (
            "call-unavailable",
            "image generation is temporarily unavailable (HTTP 502)",
        ),
    ] {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": "normai_image_generation",
            "arguments": json!({"prompt":"A red circle."}).to_string()
        }))
        .unwrap();
        assert!(matches!(
            start_response_tool(&state, &user, &thread, input, &tool)
                .await
                .unwrap(),
            Some(PendingToolCall::Answered(_))
        ));
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
        let output = history.last().unwrap();
        assert_eq!(output.payload["type"], "function_call_output");
        assert_eq!(output.payload["call_id"], call_id);
        assert_eq!(
            serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
            json!({"error": expected})
        );
    }
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0],
        json!({"model":"gpt-image-2","prompt":"A red circle."})
    );
}

#[tokio::test]
async fn image_generation_arguments_are_validated_before_the_image_request() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-argument-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    for (call_id, arguments, expected) in [
        (
            "call-missing",
            json!({}),
            "normai_image_generation arguments must contain a prompt",
        ),
        (
            "call-empty",
            json!({"prompt":"   "}),
            "normai_image_generation prompt must not be empty",
        ),
    ] {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": "normai_image_generation",
            "arguments": arguments.to_string()
        }))
        .unwrap();
        assert!(matches!(
            start_response_tool(&state, &user, &thread, input, &tool)
                .await
                .unwrap(),
            Some(PendingToolCall::Answered(_))
        ));
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
        let output = history.last().unwrap();
        assert_eq!(output.payload["type"], "function_call_output");
        let value: Value =
            serde_json::from_str(output.payload["output"].as_str().unwrap()).unwrap();
        assert!(
            value["error"].as_str().unwrap().contains(expected),
            "{value}"
        );
    }
}

#[tokio::test]
async fn image_generation_forwards_reference_images_from_the_input() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-reference-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record_with_images(
        &state,
        &user,
        &thread,
        &["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (_headers, request) = read_http_request(&mut socket).await;
        let body = json!({"data":[{"b64_json":"iVBORw0KGgo"}]}).to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        request
    });
    let upstream = insert_upstream(&state, &user, "images", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-image",
        "call_id":"call-image",
        "name":"normai_image_generation",
        "arguments": json!({"prompt":"A watercolor variant.","reference_images":[1,2]}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let request = server.await.unwrap();
    assert_eq!(
        request,
        json!({
            "model":"gpt-image-2",
            "prompt":"A watercolor variant.",
            "reference_images":["data:image/png;base64,AAAA","data:image/jpeg;base64,BBBB"]
        })
    );
}

#[tokio::test]
async fn image_generation_reference_images_are_validated_against_the_input() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-reference-error-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record_with_images(
        &state,
        &user,
        &thread,
        &["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    )
    .await;
    // No upstream fixture: invalid references must be answered to the model
    // before any image request leaves the controller.
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    for (call_id, reference_images, expected) in [
        (
            "call-zero",
            json!([0]),
            "reference image position 0 is out of range",
        ),
        (
            "call-beyond",
            json!([3]),
            "reference image position 3 is out of range",
        ),
        (
            "call-many",
            json!([1, 1, 1, 1, 1]),
            "at most 4 reference images are supported",
        ),
    ] {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": "normai_image_generation",
            "arguments": json!({"prompt":"A red circle.","reference_images":reference_images}).to_string()
        }))
        .unwrap();
        assert!(matches!(
            start_response_tool(&state, &user, &thread, input, &tool)
                .await
                .unwrap(),
            Some(PendingToolCall::Answered(_))
        ));
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
        let output = history.last().unwrap();
        assert_eq!(output.payload["type"], "function_call_output");
        let value: Value =
            serde_json::from_str(output.payload["output"].as_str().unwrap()).unwrap();
        assert!(
            value["error"].as_str().unwrap().contains(expected),
            "{value}"
        );
    }

    // A turn without attached pictures answers the same way through a
    // dedicated message instead of a position error.
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-no-images",
        "call_id":"call-no-images",
        "name":"normai_image_generation",
        "arguments": json!({"prompt":"A red circle.","reference_images":[1]}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let value: Value =
        serde_json::from_str(history.last().unwrap().payload["output"].as_str().unwrap()).unwrap();
    assert!(
        value["error"]
            .as_str()
            .unwrap()
            .contains("no attached images"),
        "{value}"
    );
}

#[tokio::test]
async fn superseded_image_generation_outcomes_are_activity() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "image-generation-superseded-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = json!({"data":[{"b64_json":"iVBORw0KGgo"}]}).to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let upstream = insert_upstream(&state, &user, "images", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    set_thread_image_generation_model(&state, &user, &thread.id, "gpt-image-2").await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let thread_id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({"role":"user","content":"newer input"}),
        );
        Ok(())
    })
    .await
    .unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-image",
        "call_id":"call-image",
        "name":"normai_image_generation",
        "arguments": json!({"prompt":"A red circle."}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    server.await.unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    for record in &history[history.len() - 2..] {
        assert_eq!(record.kind, "activity");
    }
    assert_eq!(
        history[history.len() - 1].payload["type"],
        "image_generation_call"
    );
}

#[tokio::test]
async fn web_search_calls_the_upstream_web_search_endpoint_and_returns_sources() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "web-search-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let (headers, request) = read_http_request(&mut socket).await;
        let body = json!({
            "created": 1,
            "model": "deepseek-flash",
            "queries": ["rust release"],
            "sources": [
                {"url": "https://example.com/one", "title": "One", "snippet": "excerpt one"},
                {"url": "https://example.com/two"}
            ],
            "truncated": false,
            "usage": {"input_tokens": 9, "output_tokens": 12}
        })
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        (headers, request)
    });
    let upstream = insert_upstream(&state, &user, "search", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-search",
        "call_id":"call-search",
        "name":"normai_web_search",
        "arguments": json!({"query":"  rust release  "}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    let (headers, request) = server.await.unwrap();
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case("authorization: Bearer sk-fixture"))
    );
    let expected_user_agent = format!("user-agent: cybion/{}", env!("CARGO_PKG_VERSION"));
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case(&expected_user_agent))
    );
    assert!(
        headers
            .lines()
            .any(|line| line.eq_ignore_ascii_case("originator: cybion"))
    );
    assert_eq!(request, json!({"source":"deepseek","query":"rust release"}));
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = history.last().unwrap();
    assert_eq!(output.kind, "tool_output");
    assert_eq!(output.payload["type"], "function_call_output");
    assert_eq!(output.payload["call_id"], "call-search");
    assert_eq!(
        serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
        json!({
            "status": "completed",
            "queries": ["rust release"],
            "sources": [
                {"url": "https://example.com/one", "title": "One", "snippet": "excerpt one"},
                {"url": "https://example.com/two"}
            ]
        })
    );
    // The settled call and its sources replay together as one turn.
    let items = vec![tool.value(), output.payload.clone()];
    assert_eq!(replayable_context_items(&items).len(), 2);
}

#[tokio::test]
async fn web_search_failures_are_answered_to_the_model() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "web-search-failure-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in [
            (
                "400 Bad Request",
                "{\"error\":\"source must be deepseek or openai\"}",
            ),
            (
                "503 Service Unavailable",
                "{\"error\":\"provider_pool_empty\"}",
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_json_request(&mut socket).await);
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        requests
    });
    let upstream = insert_upstream(&state, &user, "search", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    for (call_id, expected) in [
        ("call-rejected", "web search was rejected (HTTP 400)"),
        (
            "call-unavailable",
            "web search is temporarily unavailable (HTTP 503)",
        ),
    ] {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": "normai_web_search",
            "arguments": json!({"query":"rust release"}).to_string()
        }))
        .unwrap();
        assert!(matches!(
            start_response_tool(&state, &user, &thread, input, &tool)
                .await
                .unwrap(),
            Some(PendingToolCall::Answered(_))
        ));
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
        let output = history.last().unwrap();
        assert_eq!(output.payload["type"], "function_call_output");
        assert_eq!(output.payload["call_id"], call_id);
        assert_eq!(
            serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
            json!({"error": expected})
        );
    }
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0],
        json!({"source":"deepseek","query":"rust release"})
    );
}

#[tokio::test]
async fn web_search_arguments_are_validated_before_the_search_request() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "web-search-argument-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    for (call_id, arguments, expected) in [
        (
            "call-missing",
            json!({}),
            "normai_web_search arguments must contain a query",
        ),
        (
            "call-empty",
            json!({"query":"   "}),
            "normai_web_search query must not be empty",
        ),
    ] {
        let tool = ResponseItem::from_value(json!({
            "type":"function_call",
            "id": format!("fc-{call_id}"),
            "call_id": call_id,
            "name": "normai_web_search",
            "arguments": arguments.to_string()
        }))
        .unwrap();
        assert!(matches!(
            start_response_tool(&state, &user, &thread, input, &tool)
                .await
                .unwrap(),
            Some(PendingToolCall::Answered(_))
        ));
        let history = history_for(&state, &user, thread.id.clone(), 0)
            .await
            .unwrap();
        let output = history.last().unwrap();
        assert_eq!(output.payload["type"], "function_call_output");
        let value: Value =
            serde_json::from_str(output.payload["output"].as_str().unwrap()).unwrap();
        assert!(
            value["error"].as_str().unwrap().contains(expected),
            "{value}"
        );
    }
}

#[tokio::test]
async fn superseded_web_search_outcomes_are_activity() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "web-search-superseded-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input = input_record(&state, &user, &thread).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let body = json!({
            "created": 1,
            "queries": ["rust release"],
            "sources": [{"url": "https://example.com/one"}]
        })
        .to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let upstream = insert_upstream(&state, &user, "search", &format!("http://{address}")).await;
    bind_thread_upstream(&state, &user, &thread.id, &upstream.id).await;
    let thread = read_thread_for(&state, &user, thread.id).await.unwrap();
    let thread_id = thread.id.clone();
    user_db(&state, &user, false, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({"role":"user","content":"newer input"}),
        );
        Ok(())
    })
    .await
    .unwrap();
    let tool = ResponseItem::from_value(json!({
        "type":"function_call",
        "id":"fc-search",
        "call_id":"call-search",
        "name":"normai_web_search",
        "arguments": json!({"query":"rust release"}).to_string()
    }))
    .unwrap();
    assert!(matches!(
        start_response_tool(&state, &user, &thread, input, &tool)
            .await
            .unwrap(),
        Some(PendingToolCall::Answered(_))
    ));
    server.await.unwrap();
    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = history.last().unwrap();
    assert_eq!(output.kind, "activity");
    assert_eq!(output.payload["type"], "function_call_output");
}
