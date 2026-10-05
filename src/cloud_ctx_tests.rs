use super::tests::test_state;
use super::*;

struct MockCtx {
    documents: Vec<Value>,
    details: Vec<Value>,
    calls: Vec<String>,
    created: usize,
    documents_status: StatusCode,
}

async fn mock_ctx(State(remote): State<Arc<Mutex<MockCtx>>>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    let mut remote = remote.lock().await;
    remote.calls.push(format!("{method} {path} {bearer}"));
    if path == "/api/v1/documents" {
        if remote.documents_status != StatusCode::OK {
            return (
                remote.documents_status,
                Json(json!({"error":"fixture rejection"})),
            )
                .into_response();
        }
        return Json(Value::Array(remote.documents.clone())).into_response();
    }
    if let Some(id) = path.strip_prefix("/api/v1/documents/") {
        if let Some(detail) = remote
            .details
            .iter()
            .find(|detail| detail["document"]["id"] == json!(id))
        {
            return Json(detail.clone()).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    }
    if path == "/api/v1/api-keys" {
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(body["label"], json!("Cybion"));
        remote.created += 1;
        let created = remote.created;
        return Json(json!({
            "id": format!("key-{created}"),
            "label": "Cybion",
            "prefix": "0123456789",
            "created_at": 1,
            "last_used_at": null,
            "secret": format!("ctx_ctx-owner_secret-{created}"),
        }))
        .into_response();
    }
    if let Some(id) = path.strip_prefix("/api/v1/api-keys/") {
        assert_eq!(method, reqwest::Method::DELETE);
        assert!(!id.is_empty());
        return StatusCode::NO_CONTENT.into_response();
    }
    panic!("unexpected CTX route {method} {path}");
}

struct CtxFixture {
    _root: tempfile::TempDir,
    state: AppState,
    user: User,
    remote: Arc<Mutex<MockCtx>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for CtxFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture() -> CtxFixture {
    let (root, mut state) = test_state();
    let user = user_for_subject(&state, "ctx-owner").unwrap();
    let remote = Arc::new(Mutex::new(MockCtx {
        documents: Vec::new(),
        details: Vec::new(),
        calls: Vec::new(),
        created: 0,
        documents_status: StatusCode::OK,
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(mock_ctx).with_state(remote.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state.ctx_api_url = base;
    CtxFixture {
        _root: root,
        state,
        user,
        remote,
        server,
    }
}

fn identity(f: &CtxFixture) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: f.user.clone(),
        bearer: "owner-auth-fixture".into(),
    })
}

async fn set_documents(f: &CtxFixture, documents: Vec<Value>) {
    f.remote.lock().await.documents = documents;
}

async fn store_key(f: &CtxFixture, key: &str, key_id: &str) {
    let key = key.to_owned();
    let key_id = key_id.to_owned();
    user_db(&f.state, &f.user, true, move |connection| {
        connection.execute(
            "INSERT INTO integration_settings(id,updated_at) VALUES(1,?) ON CONFLICT(id) DO NOTHING",
            params![now()],
        )?;
        connection.execute(
            "UPDATE integration_settings SET ctx_api_key=?,ctx_api_key_id=? WHERE id=1",
            params![key, key_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

async fn insert_local(f: &CtxFixture, id: &str, name: &str, content: &str) {
    let id = id.to_owned();
    let name = name.to_owned();
    let content = content.to_owned();
    user_db(&f.state, &f.user, true, move |connection| {
        connection.execute(
            "INSERT INTO contexts(id,name,description,content,parent_id) VALUES(?,?,?,?,NULL)",
            params![id, name, "", content],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}

fn saved_settings(f: &CtxFixture) -> IntegrationSettings {
    integration_settings(&open_user(&f.user.path, false).unwrap()).unwrap()
}

fn article(id: &str, title: &str, parent: Option<&str>, description: &str) -> Value {
    json!({
        "id": id,
        "owner_id": "ctx-owner",
        "title": title,
        "kind": "article",
        "parent_id": parent,
        "metadata": {"description": description},
    })
}

fn detail(document: &Value, content: &str) -> Value {
    json!({
        "document": document,
        "revision": {"id": "rev-1", "document_id": document["id"], "content": content},
        "descendant_count": 0,
    })
}

#[tokio::test]
async fn connect_stores_a_cybion_key_and_disconnect_revokes_it() {
    let f = fixture().await;
    let status = ctx_contexts::connect(State(f.state.clone()), identity(&f))
        .await
        .unwrap()
        .0;
    assert!(status.connected);
    assert_eq!(status.key_id.as_deref(), Some("key-1"));
    let saved = saved_settings(&f);
    assert_eq!(saved.ctx_api_key, format!("ctx_{}_secret-1", f.user.id));
    assert_eq!(saved.ctx_api_key_id, "key-1");
    assert_eq!(
        f.remote.lock().await.calls[0],
        "POST /api/v1/api-keys Bearer owner-auth-fixture"
    );

    let status = ctx_contexts::connect(State(f.state.clone()), identity(&f))
        .await
        .unwrap()
        .0;
    assert_eq!(status.key_id.as_deref(), Some("key-2"));
    let calls = f.remote.lock().await.calls.clone();
    assert_eq!(
        calls[1],
        "DELETE /api/v1/api-keys/key-1 Bearer owner-auth-fixture"
    );
    assert_eq!(calls[2], "POST /api/v1/api-keys Bearer owner-auth-fixture");
    assert_eq!(
        saved_settings(&f).ctx_api_key,
        format!("ctx_{}_secret-2", f.user.id)
    );

    let view = ctx_contexts::disconnect(State(f.state.clone()), identity(&f))
        .await
        .unwrap()
        .0;
    assert!(!view.connected);
    assert!(view.revoked);
    let saved = saved_settings(&f);
    assert!(saved.ctx_api_key.is_empty());
    assert!(saved.ctx_api_key_id.is_empty());
}

#[tokio::test]
async fn connect_surfaces_ctx_rejections_as_actionable_errors() {
    let f = fixture().await;
    let broken = fixture_with_url(&f, "http://127.0.0.1:9").await;
    let error = ctx_contexts::connect(State(broken.state.clone()), identity(&broken))
        .await
        .unwrap_err();
    assert!(error.message.contains("CTX"));
}

async fn fixture_with_url(f: &CtxFixture, base: &str) -> CtxFixture {
    CtxFixture {
        _root: tempfile::tempdir().unwrap(),
        state: {
            let mut state = f.state.clone();
            state.ctx_api_url = base.to_owned();
            state
        },
        user: f.user.clone(),
        remote: f.remote.clone(),
        server: tokio::spawn(async {}),
    }
}

#[tokio::test]
async fn list_tool_concatenates_local_contexts_and_ctx_top_level_documents() {
    let f = fixture().await;
    store_key(&f, "ctx_key_1", "key-1").await;
    insert_local(
        &f,
        "11111111-1111-4111-8111-111111111111",
        "Local",
        "local content",
    )
    .await;
    set_documents(
        &f,
        vec![
            article("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Alpha", None, "first"),
            article("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Bravo", None, ""),
            article("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Child", Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), ""),
            json!({"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","title":"Profile","kind":"profile","parent_id":null,"metadata":{}}),
        ],
    )
    .await;

    let output = list_contexts_tool_output(&f.state, &f.user).await.unwrap();
    let contexts = output["contexts"].as_array().unwrap();
    let names = contexts
        .iter()
        .map(|context| context["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["Local", "Alpha", "Bravo"]);
    assert_eq!(
        contexts[0]["context_id"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(
        contexts[1]["context_id"],
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    assert_eq!(contexts[1]["description"], "first");
    assert_eq!(contexts[2]["description"], "");
    assert!(output.get("notice").is_none());
    assert_eq!(
        f.remote.lock().await.calls,
        ["GET /api/v1/documents Bearer ctx_key_1"]
    );
}

#[tokio::test]
async fn read_tool_reads_ctx_documents_with_children_and_prefers_local_contexts() {
    let f = fixture().await;
    store_key(&f, "ctx_key_1", "key-1").await;
    let alpha = article(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Alpha",
        None,
        "first",
    );
    set_documents(
        &f,
        vec![
            alpha.clone(),
            article(
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "Child",
                Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                "",
            ),
        ],
    )
    .await;
    f.remote.lock().await.details = vec![detail(&alpha, "# Alpha\n\nbody")];

    let output = read_context_tool_output(
        &f.state,
        &f.user,
        &json!({"context_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(output["name"], "Alpha");
    assert_eq!(output["content"], "# Alpha\n\nbody");
    assert_eq!(output["parent_id"], Value::Null);
    let children = output["children"].as_array().unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(
        children[0]["context_id"],
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    );

    insert_local(
        &f,
        "22222222-2222-4222-8222-222222222222",
        "LocalOnly",
        "local body",
    )
    .await;
    let output = read_context_tool_output(
        &f.state,
        &f.user,
        &json!({"context_id":"22222222-2222-4222-8222-222222222222"}).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(output["content"], "local body");

    let missing = read_context_tool_output(
        &f.state,
        &f.user,
        &json!({"context_id":"33333333-3333-4333-8333-333333333333"}).to_string(),
    )
    .await
    .unwrap();
    assert_eq!(missing["error"], "context not found");
}

#[tokio::test]
async fn read_tool_reports_not_connected_without_a_stored_key() {
    let f = fixture().await;
    let output = read_context_tool_output(
        &f.state,
        &f.user,
        &json!({"context_id":"33333333-3333-4333-8333-333333333333"}).to_string(),
    )
    .await
    .unwrap();
    assert!(output["error"].as_str().unwrap().contains("not connected"));
}

#[tokio::test]
async fn list_tool_degrades_with_a_notice_when_ctx_is_unreachable() {
    let f = fixture().await;
    store_key(&f, "ctx_key_1", "key-1").await;
    insert_local(&f, "11111111-1111-4111-8111-111111111111", "Local", "local").await;
    let broken = fixture_with_url(&f, "http://127.0.0.1:9").await;

    let output = list_contexts_tool_output(&broken.state, &broken.user)
        .await
        .unwrap();
    assert_eq!(output["contexts"].as_array().unwrap().len(), 1);
    assert!(output["notice"].as_str().unwrap().contains("CTX"));

    let output = read_context_tool_output(
        &broken.state,
        &broken.user,
        &json!({"context_id":"33333333-3333-4333-8333-333333333333"}).to_string(),
    )
    .await
    .unwrap();
    assert!(output["error"].as_str().unwrap().contains("CTX"));
}

#[tokio::test]
async fn documents_view_exposes_top_level_documents_for_the_configuration_page() {
    let f = fixture().await;
    store_key(&f, "ctx_key_1", "key-1").await;
    set_documents(
        &f,
        vec![article(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "Alpha",
            None,
            "first",
        )],
    )
    .await;
    let view = ctx_contexts::documents_for(&f.state, &f.user)
        .await
        .unwrap();
    assert!(view.connected);
    assert_eq!(view.documents.len(), 1);
    assert_eq!(
        view.documents[0].context_id,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    assert!(view.notice.is_none());
}

#[tokio::test]
async fn ctx_integration_columns_are_added_to_existing_user_databases() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("user.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(USER_SCHEMA).unwrap();
    // Deployed version 25 databases already carry the Worker-sharing columns
    // (their schema history passed the version 22 rebuild); mirror that in the
    // fixture so the upgrade only exercises the missing CTX columns.
    connection
        .execute_batch(
            "ALTER TABLE worker_calls ADD COLUMN caller_user_id TEXT;
             ALTER TABLE integration_settings DROP COLUMN ctx_api_key;
             ALTER TABLE integration_settings DROP COLUMN ctx_api_key_id;
             PRAGMA user_version = 25;",
        )
        .unwrap();
    drop(connection);

    let connection = open_user(&path, true).unwrap();
    let columns = connection
        .prepare("PRAGMA table_info(integration_settings)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap();
    assert!(columns.contains(&"ctx_api_key".to_owned()));
    assert!(columns.contains(&"ctx_api_key_id".to_owned()));
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
}
