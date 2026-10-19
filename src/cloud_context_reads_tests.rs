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

fn function_call_output(call_id: &str) -> Value {
    json!({ "type": "function_call_output", "call_id": call_id, "output": "{\"id\":\"seen\"}" })
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
            function_call_output("call_read_1"),
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
        view.calls.iter().map(|call| call.id).collect::<Vec<_>>(),
        [first_call, tail]
    );
    assert_eq!(
        view.calls[1].payload["arguments"],
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
        view.calls.iter().map(|call| call.id).collect::<Vec<_>>(),
        [after]
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
