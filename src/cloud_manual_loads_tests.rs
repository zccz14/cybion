use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

fn insert_manual(connection: &Connection, id: &str, content: &str) {
    connection
        .execute(
            "INSERT INTO manuals(id,name,description,content,parent_id,sort_key,trashed_at)
             VALUES(?,'Manual','Use when working',?,NULL,'01',NULL)",
            params![id, content],
        )
        .unwrap();
}

fn load(connection: &Connection, thread_id: &str, manual_id: &str) {
    connection
        .execute(
            "INSERT INTO thread_manual_loads(thread_id,manual_id,loaded_at) VALUES(?,?,?)",
            params![thread_id, manual_id, now()],
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
async fn a_loaded_manual_is_delivered_once_as_a_developer_message() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-deliver").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let manual = "77777777-7777-4777-8777-777777777777";
    let (first, repeat, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "正文甲");
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let first = manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let repeat = manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        Ok((first, repeat, developer_messages(&compiled.items)))
    })
    .await
    .unwrap();
    assert!(first.is_some());
    assert_eq!(repeat, None, "an unchanged loaded Manual is not repeated");
    assert_eq!(messages.len(), 1);
    assert!(messages[0].contains("正文甲"), "{}", messages[0]);
    assert!(messages[0].contains(manual));
    assert!(messages[0].contains("is loaded in this Thread"));
    // The copy is the Manual JSON the tool would have answered with.
    assert!(messages[0].contains("\"content\": \"正文甲\""));
    assert!(!messages[0].contains("sort_key"));
}

#[tokio::test]
async fn an_edited_loaded_manual_is_delivered_again_and_the_earlier_copy_stays() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-edit").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let manual = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (second, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "旧正文");
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let first = manual_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        connection
            .execute("UPDATE manuals SET content='新正文' WHERE id=?", [manual])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let second = manual_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        assert!(second > first);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        let stored: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM history_records WHERE thread_id=? AND kind='activity'
                   AND json_extract(payload,'$.type')='manual_loaded'",
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
async fn a_checkpoint_makes_the_next_compile_deliver_the_loaded_manual_again() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-checkpoint").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let manual = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (checkpoint, delivered) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "手册正文");
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        let checkpoint = insert_record(
            connection,
            &thread_id,
            "checkpoint",
            json!({ "role": "developer", "content": "# Durable working context" }),
        );
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let delivered = manual_loads::append_injections(connection, &thread_id, tail)
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
    let manual = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let (notice, after_edit, messages) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "正文");
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        connection
            .execute(
                "DELETE FROM thread_manual_loads WHERE thread_id=? AND manual_id=?",
                params![thread_id, manual],
            )
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let notice = manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        connection
            .execute("UPDATE manuals SET content='改过' WHERE id=?", [manual])
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        let after_edit = manual_loads::append_injections(connection, &thread_id, tail).unwrap();
        let compiled = compile_thread_context(connection, &data_dir, &thread_id, tail).unwrap();
        Ok((notice, after_edit, developer_messages(&compiled.items)))
    })
    .await
    .unwrap();
    assert!(notice.is_some());
    assert_eq!(
        after_edit, None,
        "a released Manual is not refreshed any more"
    );
    assert!(
        messages
            .iter()
            .any(|message| message.contains("is no longer loaded in this Thread"))
    );
    assert!(!messages.iter().any(|message| message.contains("改过")));
}

#[tokio::test]
async fn a_manual_that_stops_resolving_releases_itself() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-missing").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let manual = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    let messages = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "正文");
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        manual_loads::append_injections(connection, &thread_id, tail)
            .unwrap()
            .unwrap();
        connection
            .execute(
                "UPDATE manuals SET trashed_at=? WHERE id=?",
                params![now(), manual],
            )
            .unwrap();
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        assert!(
            manual_loads::append_injections(connection, &thread_id, tail)
                .unwrap()
                .is_some()
        );
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        assert_eq!(
            manual_loads::append_injections(connection, &thread_id, tail).unwrap(),
            None,
            "the release is announced once"
        );
        let loaded = manual_loads::loaded_ids(connection, &thread_id).unwrap();
        assert!(loaded.is_empty(), "a hidden Manual stops being loaded");
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
    let manual = "12121212-1212-4212-8212-121212121212";
    user_db(&state, &user, true, move |connection| {
        insert_manual(connection, manual, "正文");
        Ok(())
    })
    .await
    .unwrap();
    let arguments = json!({ "manual_id": manual }).to_string();
    let first = manual_loads::load_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(first["loaded"], json!(true));
    assert_eq!(first["already_loaded"], json!(false));
    assert!(first["note"].as_str().unwrap().contains("controller"));
    let again = manual_loads::load_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(
        again["already_loaded"],
        json!(true),
        "loading twice binds once"
    );
    let thread_id = thread.id.clone();
    let bound = user_db(&state, &user, true, move |connection| {
        manual_loads::loaded_ids(connection, &thread_id)
    })
    .await
    .unwrap();
    assert_eq!(bound, vec![manual.to_owned()]);
    let released = manual_loads::unload_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(released["unloaded"], json!(true));
    let missing = manual_loads::unload_tool_output(&state, &user, &thread.id, &arguments)
        .await
        .unwrap();
    assert_eq!(missing["unloaded"], json!(false));
    let unknown = manual_loads::load_tool_output(
        &state,
        &user,
        &thread.id,
        &json!({ "manual_id": "00000000-0000-4000-8000-000000000000" }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(unknown["error"], json!("manual not found"));
}

#[tokio::test]
async fn the_loaded_set_is_capped() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-cap").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let manual = "13131313-1313-4313-8313-131313131313";
    let thread_id = thread.id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_manual(connection, manual, "正文");
        for index in 0..manual_loads::MAX_LOADED_THREAD {
            let id = format!("00000000-0000-4000-8000-0000000020{index:02}");
            insert_manual(connection, &id, "正文");
            load(connection, &thread_id, &id);
        }
        Ok(())
    })
    .await
    .unwrap();
    let refused = manual_loads::load_tool_output(
        &state,
        &user,
        &thread.id,
        &json!({ "manual_id": manual }).to_string(),
    )
    .await
    .unwrap();
    assert!(
        refused["error"].as_str().unwrap().contains("unload_manual"),
        "{refused}"
    );
}

#[tokio::test]
async fn the_loaded_view_reports_the_bound_manuals() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-view").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let first = "14141414-1414-4414-8414-141414141414";
    let second = "16161616-1616-4616-8616-161616161616";
    user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, first, "正文甲");
        insert_manual(connection, second, "正文乙");
        load(connection, &thread_id, first);
        load(connection, &thread_id, second);
        Ok(())
    })
    .await
    .unwrap();
    let view = loaded_manuals_for(&state, &user, thread.id.clone())
        .await
        .unwrap();
    assert_eq!(view.loaded, vec![first.to_owned(), second.to_owned()]);
    let (head, tail) = (
        view.head.expect("a started Thread has a head"),
        view.tail.unwrap(),
    );
    assert!(
        head <= tail,
        "the range the view reports is the one that replays"
    );
}

#[tokio::test]
async fn the_copy_arrives_right_after_the_load_answer() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "loads-order").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let thread_id = thread.id.clone();
    let data_dir = state.data_dir.clone();
    let manual = "15151515-1515-4515-8515-151515151515";
    let (tool_output, copy) = user_db(&state, &user, true, move |connection| {
        start_thread(connection, &thread_id);
        insert_manual(connection, manual, "手册正文");
        insert_record(
            connection,
            &thread_id,
            "response_output",
            json!({
                "type": "function_call",
                "name": "load_manual",
                "arguments": json!({ "manual_id": manual }).to_string(),
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
                "output": json!({ "manual_id": manual, "loaded": true }).to_string(),
            }),
        );
        load(connection, &thread_id, manual);
        let tail = latest_protocol_record_id(connection, &thread_id).unwrap();
        manual_loads::append_injections(connection, &thread_id, tail).unwrap();
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
