use super::tests::test_state;
use super::*;

async fn insert_local_context(state: &AppState, user: &User, id: &str, name: &str) {
    let id = id.to_owned();
    let name = name.to_owned();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO contexts(id,name,description,content,parent_id) VALUES(?,?,?,?,NULL)",
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

#[tokio::test]
async fn list_tool_lists_the_common_root_before_local_contexts() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-context-user").unwrap();
    insert_local_context(
        &state,
        &user,
        "11111111-1111-4111-8111-111111111111",
        "Local",
    )
    .await;

    let output = list_contexts_tool_output(&state, &user).await.unwrap();
    let contexts = output["contexts"].as_array().unwrap();
    assert_eq!(contexts.len(), 2);
    assert_eq!(contexts[0], common_contexts::root_summary());
    assert_eq!(
        contexts[1]["context_id"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(contexts[1]["source"], "local");
}

#[tokio::test]
async fn read_tool_reads_common_nodes_with_parent_and_children() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-context-reader").unwrap();
    let root_id = common_contexts::root_summary()["context_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let output = read_context_tool_output(
        &state,
        &user,
        &json!({ "context_id": root_id.as_str() }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(output["name"], "Cybion Common Context");
    assert_eq!(output["parent_id"], Value::Null);
    assert!(
        output["content"]
            .as_str()
            .unwrap()
            .contains("common-contexts/")
    );
    let children = output["children"].as_array().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0]["name"], "Ultimate Machine（终极机器）");

    let child_id = children[0]["context_id"].as_str().unwrap().to_owned();
    let child = read_context_tool_output(
        &state,
        &user,
        &json!({ "context_id": child_id.as_str() }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(child["parent_id"], Value::String(root_id));
    assert_eq!(child["children"].as_array().unwrap().len(), 4);
    assert!(child["content"].as_str().unwrap().contains("终极机器"));
}

#[tokio::test]
async fn local_contexts_shadow_common_ids() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-context-shadow-user").unwrap();
    let root_id = common_contexts::root_summary()["context_id"]
        .as_str()
        .unwrap()
        .to_owned();
    insert_local_context(&state, &user, &root_id, "Shadow").await;

    let output = read_context_tool_output(
        &state,
        &user,
        &json!({ "context_id": root_id.as_str() }).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(output["name"], "Shadow");
    assert_eq!(output["content"], "Shadow content");
}

#[tokio::test]
async fn browser_read_resolves_common_nodes() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "common-context-browser").unwrap();
    let root_id = common_contexts::root_summary()["context_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let Json(view) = read_context_api(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: user.clone(),
            bearer: String::new(),
        }),
        AxumPath(root_id),
    )
    .await
    .unwrap();
    assert_eq!(view.context.name, "Cybion Common Context");
    assert_eq!(view.children.len(), 1);
}
