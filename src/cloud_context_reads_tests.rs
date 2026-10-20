use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

fn read_context_call(context_id: &str, call_id: &str) -> Value {
    json!({
        "type": "function_call",
        "name": "read_context",
        "arguments": json!({ "context_id": context_id }).to_string(),
        "call_id": call_id,
    })
}

fn read_context_output(call_id: &str, context: Value) -> Value {
    json!({ "type": "function_call_output", "call_id": call_id, "output": context.to_string() })
}

fn context_body(id: &str, name: &str, description: &str, content: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "description": description,
        "content": content,
        "parent_id": null,
        "children": [],
    })
}

fn insert_context(connection: &Connection, id: &str, content: &str) {
    connection
        .execute(
            "INSERT INTO contexts(id,name,description,content,parent_id,sort_key,trashed_at)
             VALUES(?,'Manual','Use when working',?,NULL,'01',NULL)",
            params![id, content],
        )
        .unwrap();
}

/// One turn that read a Context, so a change to it is detected afterwards.
fn insert_read_turn(connection: &Connection, thread_id: &str, context: &str, content: &str) -> i64 {
    insert_context(connection, context, content);
    insert_record(
        connection,
        thread_id,
        "input",
        json!({ "role": "user", "content": "read the manual" }),
    );
    let call = insert_record(
        connection,
        thread_id,
        "response_output",
        read_context_call(context, "call_read"),
    );
    insert_record(
        connection,
        thread_id,
        "tool_output",
        read_context_output(
            "call_read",
            context_body(context, "Manual", "Use when working", content),
        ),
    );
    call
}

#[tokio::test]
async fn an_empty_thread_reports_no_context_and_no_reads() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-empty").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let view = context_reads_for(&state, &user, thread.id.clone())
        .await
        .unwrap();
    assert!(view.head.is_none());
    assert!(view.tail.is_none());
    assert!(view.calls.is_empty());
}

#[tokio::test]
async fn reads_are_the_read_context_calls_in_the_current_context() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-window").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    let (head, tail, first_call) = user_db(&state, &user, true, move |connection| {
        let head = insert_record(
            connection,
            &thread_id,
            "input",
            json!({ "role": "user", "content": "check my manual" }),
        );
        let first = insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call("11111111-1111-1111-1111-111111111111", "call_read_1"),
        );
        insert_record(
            connection,
            &thread_id,
            "tool_output",
            json!({ "type": "function_call_output", "call_id": "call_read_1", "output": "{\"id\":\"seen\"}" }),
        );
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type": "function_call",
                "name": "bash",
                "arguments": json!({ "worker_id": "worker", "command": "ls" }).to_string(),
                "call_id": "call_bash",
            }),
        );
        let second = insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call("22222222-2222-2222-2222-222222222222", "call_read_2"),
        );
        Ok((head, second, first))
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert_eq!(view.head, Some(head));
    assert_eq!(view.tail, Some(tail));
    assert_eq!(
        view.calls
            .iter()
            .map(|call| call.record.id)
            .collect::<Vec<_>>(),
        [first_call, tail]
    );
    assert_eq!(
        view.calls[1].record.payload["arguments"],
        json!({ "context_id": "22222222-2222-2222-2222-222222222222" }).to_string()
    );
}

#[tokio::test]
async fn a_compaction_moves_the_head_past_the_reads_it_replaced() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-compacted").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    let (checkpoint, after) = user_db(&state, &user, true, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({ "role": "user", "content": "read the manual" }),
        );
        insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call("33333333-3333-3333-3333-333333333333", "call_old"),
        );
        let checkpoint = insert_record(
            connection,
            &thread_id,
            "checkpoint",
            json!({ "role": "developer", "content": "summary of the first turn" }),
        );
        let after = insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call("44444444-4444-4444-4444-444444444444", "call_new"),
        );
        Ok((checkpoint, after))
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert_eq!(view.head, Some(checkpoint));
    assert_eq!(view.tail, Some(after));
    assert_eq!(
        view.calls
            .iter()
            .map(|call| call.record.id)
            .collect::<Vec<_>>(),
        [after]
    );
}

#[tokio::test]
async fn a_read_of_an_untouched_context_is_current() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-current").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_read_turn(
            connection,
            &thread_id,
            "55555555-5555-4555-8555-555555555555",
            "# 手册\n\n第一步。",
        );
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert!(matches!(view.calls[0].state, ContextReadState::Current));
}

#[tokio::test]
async fn a_context_edited_after_the_read_is_changed() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-edited").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    user_db(&state, &user, true, move |connection| {
        let context = "66666666-6666-4666-8666-666666666666";
        insert_read_turn(connection, &thread_id, context, "旧正文");
        connection
            .execute("UPDATE contexts SET content='新正文' WHERE id=?", [context])
            .unwrap();
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert!(matches!(view.calls[0].state, ContextReadState::Changed));
}

#[tokio::test]
async fn a_context_hidden_since_the_read_is_missing() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-trashed").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    user_db(&state, &user, true, move |connection| {
        let context = "77777777-7777-4777-8777-777777777777";
        insert_read_turn(connection, &thread_id, context, "正文");
        connection
            .execute("UPDATE contexts SET trashed_at=1 WHERE id=?", [context])
            .unwrap();
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert!(matches!(view.calls[0].state, ContextReadState::Missing));
}

#[tokio::test]
async fn a_read_the_model_never_received_is_unanswered() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-unanswered").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_context(connection, "88888888-8888-4888-8888-888888888888", "正文");
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({ "role": "user", "content": "read the manual" }),
        );
        insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call("88888888-8888-4888-8888-888888888888", "call_read"),
        );
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert!(matches!(view.calls[0].state, ContextReadState::Unanswered));
}

#[tokio::test]
async fn a_common_context_read_compares_against_the_compiled_copy() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-common").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let read_id = thread_id.clone();
    let root = common_contexts::read(
        common_contexts::root_summary(common_contexts::SOURCE_LANGUAGE)["context_id"]
            .as_str()
            .unwrap(),
        common_contexts::SOURCE_LANGUAGE,
    )
    .unwrap();
    let body = context_body(
        &root.context.id,
        &root.context.name,
        &root.context.description,
        &root.context.content,
    );
    let root_id = root.context.id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({ "role": "user", "content": "read the common context" }),
        );
        insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call(&root_id, "call_read"),
        );
        insert_record(
            connection,
            &thread_id,
            "tool_output",
            read_context_output("call_read", body),
        );
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, read_id).await.unwrap();
    assert!(matches!(view.calls[0].state, ContextReadState::Current));
}

#[tokio::test]
async fn a_changed_context_is_announced_once_and_compiled_as_a_developer_message() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "dirty-notice").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "99999999-9999-4999-8999-999999999999";
    let (first, second, items) = user_db(&state, &user, true, move |connection| {
        let read = insert_read_turn(connection, &thread_id, context, "旧正文");
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        connection
            .execute("UPDATE contexts SET content='新正文' WHERE id=?", [context])
            .unwrap();
        let notice = append_context_dirty_notice(connection, &thread_id, tail).unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let repeat = append_context_dirty_notice(connection, &thread_id, tail).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        let messages = compiled
            .items
            .iter()
            .filter(|item| item["role"] == "developer" && item["content"].is_string())
            .cloned()
            .collect::<Vec<_>>();
        Ok((read, (notice, repeat), messages))
    })
    .await
    .unwrap();
    let (notice, repeat) = second;
    assert!(notice.is_some());
    assert!(notice.is_some_and(|id| id > first));
    assert_eq!(repeat, None, "the same change is announced once");
    assert_eq!(items.len(), 1);
    let content = items[0]["content"].as_str().unwrap();
    assert!(
        content.contains(context),
        "the notice names the Context: {content}"
    );
    assert!(content.contains(&format!("record #{first}")));
    // The instruction is mandatory and forbids reading past the stale copy.
    assert!(content.contains("Required, not optional"), "{content}");
    assert!(content.contains("do not use them again"), "{content}");
    assert!(
        content.contains("never fall back to the old copy"),
        "{content}"
    );
    assert!(content.contains("read_context"));
}

#[tokio::test]
async fn a_reread_after_the_change_is_announced_no_further() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "dirty-reread").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let context = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let repeat = user_db(&state, &user, true, move |connection| {
        insert_read_turn(connection, &thread_id, context, "旧正文");
        connection
            .execute("UPDATE contexts SET content='新正文' WHERE id=?", [context])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        append_context_dirty_notice(connection, &thread_id, tail).unwrap();
        insert_record(
            connection,
            &thread_id,
            "response_output",
            read_context_call(context, "call_reread"),
        );
        insert_record(
            connection,
            &thread_id,
            "tool_output",
            read_context_output(
                "call_reread",
                context_body(context, "Manual", "Use when working", "新正文"),
            ),
        );
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        append_context_dirty_notice(connection, &thread_id, tail)
    })
    .await
    .unwrap();
    assert_eq!(repeat, None, "the Thread now holds the new version");
}

#[tokio::test]
async fn a_context_that_changes_again_is_announced_again() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "dirty-twice").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let context = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (first, second) = user_db(&state, &user, true, move |connection| {
        insert_read_turn(connection, &thread_id, context, "第一版");
        connection
            .execute("UPDATE contexts SET content='第二版' WHERE id=?", [context])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let first = append_context_dirty_notice(connection, &thread_id, tail).unwrap();
        connection
            .execute("UPDATE contexts SET content='第三版' WHERE id=?", [context])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let second = append_context_dirty_notice(connection, &thread_id, tail).unwrap();
        Ok((first, second))
    })
    .await
    .unwrap();
    assert!(first.is_some());
    assert!(second.is_some());
}

#[tokio::test]
async fn a_context_notice_replays_only_as_a_developer_message() {
    let payload = json!({
        "type": "context_dirty",
        "contexts": [{ "context_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "read_record_id": 7, "current_hash": "hash" }],
    });
    let message = context_dirty_message(&payload).unwrap();
    assert_eq!(message["role"], "developer");
    assert_eq!(
        context_dirty_message(&json!({ "type": "model_switch" })),
        None
    );
    assert_eq!(
        context_dirty_message(&json!({ "type": "context_dirty", "contexts": [] })),
        None
    );
}

#[tokio::test]
async fn an_unknown_thread_is_reported_as_missing() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "reads-missing").unwrap();
    assert!(
        context_reads_for(&state, &user, Uuid::new_v4().to_string())
            .await
            .is_err()
    );
}
