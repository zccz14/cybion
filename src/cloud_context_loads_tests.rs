use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

fn insert_context(connection: &Connection, id: &str, content: &str) {
    connection
        .execute(
            "INSERT INTO contexts(id,name,description,content,parent_id,sort_key,trashed_at)
             VALUES(?,'Manual','Use when working',?,NULL,'01',NULL)",
            params![id, content],
        )
        .unwrap();
}

fn load(connection: &Connection, thread_id: &str, context_id: &str) {
    connection
        .execute(
            "INSERT INTO thread_context_loads(thread_id,context_id,loaded_at) VALUES(?,?,?)",
            params![thread_id, context_id, now()],
        )
        .unwrap();
}

fn developer_messages(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter(|item| item["role"] == "developer")
        .filter_map(|item| item["content"].as_str().map(str::to_owned))
        .collect()
}

fn start_thread(connection: &Connection, thread_id: &str) {
    insert_record(
        connection,
        thread_id,
        "input",
        json!({ "role": "user", "content": "开工" }),
    );
}

#[tokio::test]
async fn a_loaded_context_is_delivered_once_as_a_developer_message() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-deliver").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "77777777-7777-4777-8777-777777777777";
    let (first, repeat, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "正文甲");
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let first = context_loads::append_injections(connection, &thread_id, tail).unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let repeat = context_loads::append_injections(connection, &thread_id, tail).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        Ok((first, repeat, developer_messages(&compiled.items)))
    })
    .await
    .unwrap();
    assert!(first.is_some());
    assert_eq!(repeat, None, "an unchanged loaded Context is not repeated");
    assert_eq!(messages.len(), 1);
    assert!(messages[0].contains("正文甲"), "{}", messages[0]);
    assert!(messages[0].contains(context));
    assert!(messages[0].contains("is loaded in this Thread"));
    // The copy is the Context JSON the tool would have answered with.
    assert!(messages[0].contains("\"content\": \"正文甲\""));
    assert!(!messages[0].contains("sort_key"));
}

#[tokio::test]
async fn an_edited_loaded_context_is_delivered_again_and_the_earlier_copy_stays() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-edit").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (second, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "旧正文");
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let first = context_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        connection
            .execute("UPDATE contexts SET content='新正文' WHERE id=?", [context])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let second = context_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        assert!(second > first);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        let stored: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM history_records WHERE thread_id=? AND kind='activity'
                   AND json_extract(payload,'$.type')='context_loaded'",
                [&thread_id],
                |row| row.get(0),
            )
            .unwrap();
        Ok((second, (developer_messages(&compiled.items), stored)))
    })
    .await
    .unwrap();
    let (messages, stored) = messages;
    assert_eq!(stored, 2, "nothing is rewritten: both versions stay");
    assert_eq!(messages.len(), 2);
    assert!(messages[0].contains("旧正文"));
    assert!(messages[1].contains("新正文"));
    assert!(messages[1].contains("authoritative over any earlier copy"));
    assert!(second > 0);
}

#[tokio::test]
async fn a_checkpoint_makes_the_next_compile_deliver_the_loaded_context_again() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-checkpoint").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let context = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (checkpoint, delivered) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "手册正文");
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        context_loads::append_injections(connection, &thread_id, tail).unwrap();
        let checkpoint = insert_record(
            connection,
            &thread_id,
            "checkpoint",
            json!({ "role": "developer", "content": "# Durable working context" }),
        );
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let delivered = context_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        Ok((checkpoint, delivered))
    })
    .await
    .unwrap();
    assert!(
        delivered > checkpoint,
        "the copy replaced by the checkpoint is delivered again"
    );
}

#[tokio::test]
async fn unloading_stops_refreshing_and_is_announced_once() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-unload").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let (notice, after_edit, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "正文");
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        context_loads::append_injections(connection, &thread_id, tail).unwrap();
        connection
            .execute(
                "DELETE FROM thread_context_loads WHERE thread_id=? AND context_id=?",
                params![thread_id, context],
            )
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let notice = context_loads::append_injections(connection, &thread_id, tail).unwrap();
        connection
            .execute("UPDATE contexts SET content='改过' WHERE id=?", [context])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let after_edit = context_loads::append_injections(connection, &thread_id, tail).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        Ok((notice, after_edit, developer_messages(&compiled.items)))
    })
    .await
    .unwrap();
    assert!(notice.is_some());
    assert_eq!(
        after_edit, None,
        "a released Context is not refreshed any more"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains("is no longer loaded in this Thread"))
    );
    assert!(!messages.iter().any(|message| message.contains("改过")));
}

#[tokio::test]
async fn a_loaded_context_is_not_announced_as_changed() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-dirty").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let loaded = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    let read_only = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    let notice = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        for context in [loaded, read_only] {
            insert_context(connection, context, "旧正文");
        }
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type": "function_call",
                "name": "read_context",
                "arguments": json!({ "context_id": read_only }).to_string(),
                "call_id": "call_read",
            }),
        );
        insert_record(
            connection,
            &thread_id,
            "tool_output",
            json!({
                "type": "function_call_output",
                "call_id": "call_read",
                "output": json!({
                    "id": read_only,
                    "name": "Manual",
                    "description": "Use when working",
                    "content": "旧正文",
                    "parent_id": null,
                    "children": [],
                })
                .to_string(),
            }),
        );
        connection
            .execute("UPDATE contexts SET content='新正文'", [])
            .unwrap();
        load(connection, &thread_id, loaded);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        append_context_dirty_notice(connection, &thread_id, tail)
    })
    .await
    .unwrap();
    let notice = notice.expect("the read-only Context is still announced");
    let payload: Value = user_db(&state, &user, true, move |connection| {
        Ok(connection
            .query_row(
                "SELECT payload FROM history_records WHERE id=?",
                [notice],
                |row| row.get::<_, String>(0),
            )
            .unwrap())
    })
    .await
    .map(|payload| serde_json::from_str::<Value>(&payload).unwrap())
    .unwrap();
    let contexts = payload["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0]["context_id"], json!(read_only));
}

#[tokio::test]
async fn a_context_that_stops_resolving_releases_itself() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-missing").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let messages = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "正文");
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        context_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        connection
            .execute(
                "UPDATE contexts SET trashed_at=? WHERE id=?",
                params![now(), context],
            )
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        assert!(
            context_loads::append_injections(connection, &thread_id, tail)
                .unwrap()
                .is_some()
        );
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        assert_eq!(
            context_loads::append_injections(connection, &thread_id, tail).unwrap(),
            None,
            "the release is announced once"
        );
        let loaded = context_loads::loaded_ids(connection, &thread_id).unwrap();
        assert!(loaded.is_empty(), "a hidden Context stops being loaded");
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        Ok(developer_messages(&compiled.items))
    })
    .await
    .unwrap();
    assert!(
        messages
            .iter()
            .any(|message| message.contains("can no longer be read"))
    );
}

#[tokio::test]
async fn the_tools_bind_and_release_a_thread() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-tools").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let context = "12121212-1212-4212-8212-121212121212";
    user_db(&state, &user, true, move |connection| {
        insert_context(connection, context, "正文");
        Ok(())
    })
    .await
    .unwrap();
    let arguments = json!({ "context_id": context }).to_string();
    let first = context_loads::load_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(first["loaded"], json!(true));
    assert_eq!(first["already_loaded"], json!(false));
    assert!(first["note"].as_str().unwrap().contains("controller"));
    let again = context_loads::load_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(
        again["already_loaded"],
        json!(true),
        "loading twice binds once"
    );
    let thread_id = thread.id.clone();
    let bound = user_db(&state, &user, true, move |connection| {
        context_loads::loaded_ids(connection, &thread_id)
    })
    .await
    .unwrap();
    assert_eq!(bound, vec![context.to_owned()]);
    let released = context_loads::unload_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(released["unloaded"], json!(true));
    let missing = context_loads::unload_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(missing["unloaded"], json!(false));
    let unknown = context_loads::load_tool_output(
        &state,
        &user,
        &thread.id,
        &json!({ "context_id": "00000000-0000-4000-8000-000000000000" }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(unknown["error"], json!("context not found"));
}

#[tokio::test]
async fn the_loaded_set_is_capped() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-cap").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let context = "13131313-1313-4313-8313-131313131313";
    let thread_id = thread.id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_context(connection, context, "正文");
        for index in 0..context_loads::MAX_LOADED_THREAD {
            let id = format!("00000000-0000-4000-8000-0000000020{index:02}");
            insert_context(connection, &id, "正文");
            load(connection, &thread_id, &id);
        }
        Ok(())
    })
    .await
    .unwrap();
    let refused = context_loads::load_tool_output(
        &state,
        &user,
        &thread.id,
        &json!({ "context_id": context }).to_string(),
    )
    .await
    .unwrap();
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains("unload_context"),
        "{refused}"
    );
}

#[tokio::test]
async fn the_reads_view_reports_loaded_contexts_as_current() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-view").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let context = "14141414-1414-4414-8414-141414141414";
    user_db(&state, &user, true, move |connection| {
        insert_context(connection, context, "旧正文");
        start_thread(connection, &thread_id);
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type": "function_call",
                "name": "read_context",
                "arguments": json!({ "context_id": context }).to_string(),
                "call_id": "call_read",
            }),
        );
        insert_record(
            connection,
            &thread_id,
            "tool_output",
            json!({
                "type": "function_call_output",
                "call_id": "call_read",
                "output": json!({
                    "id": context,
                    "name": "Manual",
                    "description": "Use when working",
                    "content": "旧正文",
                    "parent_id": null,
                    "children": [],
                })
                .to_string(),
            }),
        );
        connection
            .execute("UPDATE contexts SET content='新正文' WHERE id=?", [context])
            .unwrap();
        load(connection, &thread_id, context);
        Ok(())
    })
    .await
    .unwrap();
    let view = context_reads_for(&state, &user, thread.id.clone())
        .await
        .unwrap();
    assert_eq!(view.loaded, vec![context.to_owned()]);
    assert_eq!(view.calls.len(), 1);
    assert!(
        matches!(view.calls[0].state, ContextReadState::Current),
        "the controller refreshes a loaded Context in place"
    );
}

#[tokio::test]
async fn the_copy_arrives_right_after_the_load_answer() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-order").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let context = "15151515-1515-4515-8515-151515151515";
    let (tool_output, copy) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_context(connection, context, "手册正文");
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type": "function_call",
                "name": "load_context",
                "arguments": json!({ "context_id": context }).to_string(),
                "call_id": "call_load",
            }),
        );
        let answer = insert_record(
            connection,
            &thread_id,
            "tool_output",
            json!({
                "type": "function_call_output",
                "call_id": "call_load",
                "output": json!({ "context_id": context, "loaded": true }).to_string(),
            }),
        );
        load(connection, &thread_id, context);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        context_loads::append_injections(connection, &thread_id, tail).unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        let copy = compiled
            .record_ids
            .iter()
            .zip(compiled.items.iter())
            .filter(|(_, item)| item["role"] == "developer")
            .find(|(_, item)| {
                item["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("is loaded in this Thread"))
            })
            .map(|(id, _)| *id);
        Ok((answer, copy))
    })
    .await
    .unwrap();
    assert!(
        copy.expect("the copy is in the same turn's replay") > tool_output,
        "the copy follows the answer that bound it"
    );
}
