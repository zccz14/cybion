use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

fn common_root_id() -> String {
    common_manuals::root_summary(common_manuals::SOURCE_LANGUAGE)["manual_id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn insert_local_manual(state: &AppState, user: &User, id: &str, name: &str) {
    let id = id.to_owned();
    let name = name.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO manuals(id,name,description,content,parent_id) VALUES(?,?,?,?,NULL)",
            params![
                id.as_str(),
                name.as_str(),
                format!("Metadata for {name}"),
                format!("{name} content")
            ],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn start_thread(state: &AppState, user: &User, thread_id: &str) {
    let thread_id = thread_id.to_owned();
    user_db(state, user, true, move |connection| {
        insert_record(
            connection,
            &thread_id,
            "input",
            json!({ "role": "user", "content": "开工" }),
        );
        Ok(())
    })
    .await
    .unwrap();
}

/// Binds a Manual to the Thread the way `load_manual` does, and returns the
/// tool answer.
async fn load(state: &AppState, user: &User, thread_id: &str, id: &str) -> Value {
    manual_loads::load_tool_output(
        state,
        user,
        thread_id,
        &json!({ "manual_id": id }).to_string(),
    )
    .await
    .unwrap()
}

/// The newest copy the compiler hands the model, parsed back out of the
/// developer message it was delivered in.
async fn loaded_copy(state: &AppState, user: &User, thread_id: &str) -> Value {
    let thread = thread_id.to_owned();
    let data_dir = state.data_dir.clone();
    let message = user_db(state, user, true, move |connection| {
        let tail = latest_protocol_record_id(connection, &thread)?;
        manual_loads::append_injections(connection, &thread, tail)?;
        let tail = latest_protocol_record_id(connection, &thread)?;
        let compiled = compile_thread_context(connection, &data_dir, &thread, tail)?;
        compiled
            .items
            .iter()
            .filter(|item| item["role"] == "developer")
            .filter_map(|item| item["content"].as_str())
            .rfind(|content| content.contains("is loaded in this Thread"))
            .map(str::to_owned)
            .ok_or_else(|| ApiError::internal("the loaded copy is missing"))
    })
    .await
    .unwrap();
    let start = message.find("```json").expect("the copy is fenced") + "```json".len();
    let rest = message[start..].trim_start();
    // The Manual body itself can contain fences, so the closing one is the last.
    let end = rest.rfind("```").expect("the copy is fenced");
    serde_json::from_str(rest[..end].trim()).expect("the copy is Manual JSON")
}

#[tokio::test]
async fn list_tool_lists_the_common_root_before_local_manuals() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-manual-user").unwrap();
    insert_local_manual(
        &state,
        &user,
        "11111111-1111-4111-8111-111111111111",
        "Local",
    )
    .await;

    let output = list_manuals_tool_output(&state, &user).await.unwrap();
    let manuals = output["manuals"].as_array().unwrap();
    assert_eq!(manuals.len(), 2);
    assert_eq!(
        manuals[0],
        common_manuals::root_summary(common_manuals::SOURCE_LANGUAGE)
    );
    assert_eq!(
        manuals[1]["manual_id"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(manuals[1]["source"], "local");
}

#[tokio::test]
async fn load_tool_delivers_common_nodes_with_parent_and_children() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-manual-reader").unwrap();
    let thread = create_test_thread(&state, &user).await;
    start_thread(&state, &user, &thread.id).await;
    let root_id = common_root_id();

    let answer = load(&state, &user, &thread.id, &root_id).await;
    assert_eq!(answer["loaded"], json!(true));

    let copy = loaded_copy(&state, &user, &thread.id).await;
    assert_eq!(copy["name"], "Cybion 公共手册");
    assert_eq!(copy["parent_id"], Value::Null);
    assert!(
        copy.get("sort_key").is_none(),
        "a sibling key is not the Thread's business"
    );
    assert!(
        copy["content"]
            .as_str()
            .unwrap()
            .contains("common-manuals/")
    );
    let children = copy["children"].as_array().unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["name"], "终极机器");
    assert_eq!(children[1]["name"], "Linkit");

    let child_id = children[0]["manual_id"].as_str().unwrap().to_owned();
    load(&state, &user, &thread.id, &child_id).await;
    let child = loaded_copy(&state, &user, &thread.id).await;
    assert_eq!(child["parent_id"], Value::String(root_id.clone()));
    assert_eq!(child["children"].as_array().unwrap().len(), 0);
    assert!(child["content"].as_str().unwrap().contains("终极机器"));

    let linkit_id = children[1]["manual_id"].as_str().unwrap().to_owned();
    load(&state, &user, &thread.id, &linkit_id).await;
    let linkit = loaded_copy(&state, &user, &thread.id).await;
    assert_eq!(linkit["parent_id"], Value::String(root_id));
    assert_eq!(linkit["children"].as_array().unwrap().len(), 0);
    assert!(
        linkit["content"]
            .as_str()
            .unwrap()
            .contains("linkit.ntnl.io")
    );
}

#[tokio::test]
async fn local_manuals_shadow_common_ids() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-manual-shadow-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    start_thread(&state, &user, &thread.id).await;
    let root_id = common_root_id();
    insert_local_manual(&state, &user, &root_id, "Shadow").await;

    load(&state, &user, &thread.id, &root_id).await;
    let copy = loaded_copy(&state, &user, &thread.id).await;
    assert_eq!(copy["name"], "Shadow");
    assert_eq!(copy["content"], "Shadow content");
}

#[tokio::test]
async fn browser_read_resolves_common_nodes() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-manual-browser").unwrap();
    let root_id = common_root_id();
    let Json(view) = read_manual_api(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: user.clone(),
            bearer: String::new(),
        }),
        AxumPath(root_id),
        Query(common_manuals::LanguageQuery { lang: None }),
    )
    .await
    .unwrap();
    assert_eq!(view.manual.name, "Cybion 公共手册");
    assert_eq!(view.children.len(), 2);
}

#[tokio::test]
async fn browser_reads_serve_the_requested_language() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-manual-language").unwrap();

    let Json(view) = read_manual_api(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: user.clone(),
            bearer: String::new(),
        }),
        AxumPath(common_root_id()),
        Query(common_manuals::LanguageQuery {
            lang: Some("en".to_string()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(view.manual.name, "Cybion Common Manual");
    assert!(view.manual.content.contains("operating guide"));
    assert_eq!(view.children[0].name, "Ultimate Machine");

    let Json(tree) = common_manuals::documents(
        axum::Extension(BrowserIdentity {
            user,
            bearer: String::new(),
        }),
        Query(common_manuals::LanguageQuery {
            lang: Some("zh".to_string()),
        }),
    )
    .await;
    assert_eq!(tree["root"]["name"], "Cybion 公共手册");
    assert!(
        tree["root"]["content"]
            .as_str()
            .unwrap()
            .contains("操作指南")
    );
}
