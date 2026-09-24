use super::*;
use crate::cloud::tests::{insert_upstream, test_state};

fn identity(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
}

fn create(upstream: CreateUpstreamInput) -> Json<CreateUpstreamInput> {
    Json(upstream)
}

#[test]
fn schema_16_materializes_the_legacy_single_configuration_and_binds_threads() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("legacy.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE integration_settings (
                id INTEGER PRIMARY KEY,
                openai_consumer_id TEXT NOT NULL,
                openai_consumer_secret TEXT NOT NULL,
                api_key TEXT NOT NULL,
                openai_base_url TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                originator TEXT NOT NULL,
                linkit_bot_id TEXT NOT NULL,
                linkit_bot_token TEXT NOT NULL,
                linkit_username TEXT NOT NULL,
                updated_at INTEGER NOT NULL
             );
             INSERT INTO integration_settings VALUES
               (1,'','consumer-secret','sk-legacy','https://api.example.com/v1','','','','','',1),
               (1,'','consumer-secret','sk-legacy','https://api.example.com/v1','','','','','',1)
             ON CONFLICT(id) DO NOTHING;
             CREATE TABLE threads (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
                reasoning_effort TEXT NOT NULL DEFAULT 'medium' CHECK(reasoning_effort IN ('none','low','medium','high','xhigh','max')),
                service_tier_fast INTEGER NOT NULL DEFAULT 0 CHECK(service_tier_fast IN (0,1)),
                status TEXT NOT NULL CHECK(status IN ('idle','running','failed')),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE thread_defaults (
                id INTEGER PRIMARY KEY CHECK(id=1),
                model TEXT NOT NULL,
                reasoning_effort TEXT NOT NULL CHECK(reasoning_effort IN ('none','low','medium','high','xhigh','max')),
                service_tier_fast INTEGER NOT NULL CHECK(service_tier_fast IN (0,1))
             );
             PRAGMA user_version=15;
             INSERT INTO threads VALUES('legacy-thread','Keep me','gpt-6-astra','high',1,'idle',1,2);
             INSERT INTO thread_defaults VALUES(1,'gpt-6-astra','max',1);",
        )
        .unwrap();
    drop(connection);

    for _ in 0..2 {
        let connection = open_user(&path, false).unwrap();
        let upstream = load_all(&connection).unwrap();
        assert_eq!(upstream.len(), 1);
        assert_eq!(upstream[0].name, "api.example.com");
        assert_eq!(upstream[0].base_url, "https://api.example.com/v1");
        // The explicit key wins over the stored consumer secret.
        assert_eq!(upstream[0].api_key, "sk-legacy");
        assert_eq!(
            connection
                .query_row(
                    "SELECT upstream_id FROM threads WHERE id='legacy-thread'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap()
                .as_deref(),
            Some(upstream[0].id.as_str())
        );
        assert_eq!(
            load_thread_defaults(&connection).unwrap().upstream_id,
            Some(upstream[0].id.clone())
        );
        check_user_foreign_keys(&connection).unwrap();
    }

    // A database without legacy credentials materializes nothing.
    let empty = tempfile::tempdir().unwrap();
    let path = empty.path().join("fresh.sqlite3");
    let connection = open_user(&path, true).unwrap();
    assert!(load_all(&connection).unwrap().is_empty());
}

#[test]
fn schema_16_materializes_a_consumer_only_configuration() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("consumer.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE integration_settings (
                id INTEGER PRIMARY KEY,
                openai_consumer_id TEXT NOT NULL,
                openai_consumer_secret TEXT NOT NULL,
                api_key TEXT NOT NULL,
                openai_base_url TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                originator TEXT NOT NULL,
                linkit_bot_id TEXT NOT NULL,
                linkit_bot_token TEXT NOT NULL,
                linkit_username TEXT NOT NULL,
                updated_at INTEGER NOT NULL
             );
             INSERT INTO integration_settings VALUES
               (1,'consumer-id','sk-consumer','','https://openai.ntnl.io/v1','','','','','',1);
             PRAGMA user_version=15;",
        )
        .unwrap();
    drop(connection);

    let connection = open_user(&path, false).unwrap();
    let upstream = load_all(&connection).unwrap();
    assert_eq!(upstream.len(), 1);
    assert_eq!(upstream[0].name, "openai.ntnl.io");
    assert_eq!(upstream[0].api_key, "sk-consumer");
}

#[tokio::test]
async fn creating_threads_requires_an_existing_upstream() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "upstream-owner").unwrap();

    let unconfigured = create_thread_for(&state, &user, serde_json::from_value(json!({})).unwrap())
        .await
        .unwrap_err();
    assert_eq!(unconfigured.status, StatusCode::CONFLICT);

    let unknown = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({"upstream_id":"00000000-0000-4000-8000-000000000001"}))
            .unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);

    let upstream = insert_upstream(&state, &user, "fixture", "http://127.0.0.1:9/v1").await;
    let explicit = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({"upstream_id": upstream.id})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(explicit.upstream_id.as_deref(), Some(upstream.id.as_str()));

    let through_defaults = update_thread_defaults(
        State(state.clone()),
        identity(&user),
        Json(ThreadDefaults {
            model: "gpt-6-astra".to_owned(),
            upstream_id: Some(upstream.id.clone()),
            reasoning_effort: "medium".to_owned(),
            service_tier_fast: false,
            context_budget_tokens: 200_000,
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        through_defaults.0.upstream_id.as_deref(),
        Some(upstream.id.as_str())
    );
    let inherited = create_thread_for(&state, &user, serde_json::from_value(json!({})).unwrap())
        .await
        .unwrap();
    assert_eq!(inherited.upstream_id.as_deref(), Some(upstream.id.as_str()));
}

#[tokio::test]
async fn upstream_crud_enforces_unique_names_and_blocks_deletion_in_use() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "crud-owner").unwrap();

    let created = create(upstreams_input(
        "alpha",
        "http://127.0.0.1:9/v1",
        Some("sk-alpha"),
    ));
    let alpha = super::create(State(state.clone()), identity(&user), created)
        .await
        .unwrap()
        .0;
    assert!(alpha.api_key_configured);
    let beta = super::create(
        State(state.clone()),
        identity(&user),
        create(upstreams_input("beta", "http://127.0.0.1:10/v1", None)),
    )
    .await
    .unwrap()
    .0;

    let duplicate = super::create(
        State(state.clone()),
        identity(&user),
        create(upstreams_input("alpha", "http://127.0.0.1:11/v1", None)),
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.status, StatusCode::CONFLICT);

    let renamed = super::update(
        State(state.clone()),
        identity(&user),
        AxumPath(beta.id.clone()),
        Json(UpdateUpstreamInput {
            name: "beta".to_owned(),
            base_url: "http://127.0.0.1:10/v1".to_owned(),
            api_key: Some("sk-beta".to_owned()),
        }),
    )
    .await
    .unwrap()
    .0;
    assert!(renamed.api_key_configured);
    let conflict = super::update(
        State(state.clone()),
        identity(&user),
        AxumPath(beta.id.clone()),
        Json(UpdateUpstreamInput {
            name: "alpha".to_owned(),
            base_url: "http://127.0.0.1:10/v1".to_owned(),
            api_key: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(conflict.status, StatusCode::CONFLICT);

    // A thread pins the upstream, so deletion fails until nothing uses it.
    let thread = create_thread_for(
        &state,
        &user,
        serde_json::from_value(json!({"upstream_id": alpha.id})).unwrap(),
    )
    .await
    .unwrap();
    let in_use = super::delete(
        State(state.clone()),
        identity(&user),
        AxumPath(alpha.id.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(in_use.status, StatusCode::CONFLICT);
    let defaults_use = update_thread_defaults(
        State(state.clone()),
        identity(&user),
        Json(ThreadDefaults {
            model: "gpt-6-astra".to_owned(),
            upstream_id: Some(beta.id.clone()),
            reasoning_effort: "medium".to_owned(),
            service_tier_fast: false,
            context_budget_tokens: 200_000,
        }),
    )
    .await
    .unwrap();
    assert!(defaults_use.0.upstream_id.is_some());
    let defaults_block = super::delete(
        State(state.clone()),
        identity(&user),
        AxumPath(beta.id.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(defaults_block.status, StatusCode::CONFLICT);

    // Rebinding frees both upstreams for deletion.
    bind_thread_to(&state, &user, &thread.id, &beta.id).await;
    assert_eq!(
        super::delete(
            State(state.clone()),
            identity(&user),
            AxumPath(alpha.id.clone())
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT
    );
    let listed = super::list(State(state), identity(&user)).await.unwrap().0;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, beta.id);
}

#[tokio::test]
async fn model_catalogs_fetch_every_upstream_and_isolate_failures() {
    use tokio::io::AsyncReadExt;

    let (_root, state) = test_state();
    let user = user_for_subject(&state, "catalog-owner").unwrap();
    assert!(
        super::models(State(state.clone()), identity(&user))
            .await
            .unwrap()
            .0
            .upstreams
            .is_empty()
    );

    let good = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let good_port = good.local_addr().unwrap().port();
    let good_task = tokio::spawn(async move {
        let (mut socket, _) = good.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        let head = loop {
            let read = socket.read(&mut buffer).await.unwrap();
            assert_ne!(read, 0);
            bytes.extend_from_slice(&buffer[..read]);
            if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break String::from_utf8(bytes[..end].to_vec()).unwrap();
            }
        };
        assert!(head.starts_with("GET /v1/models "));
        assert!(
            head.to_lowercase()
                .contains("authorization: bearer sk-good")
        );
        assert!(head.to_lowercase().contains("session-id: "));
        let body = json!({"object":"list","data":[{"id":"gpt-6-astra"},{"id":"deepseek-flash"}]})
            .to_string();
        use tokio::io::AsyncWriteExt;
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
    let bad = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bad_port = bad.local_addr().unwrap().port();
    let bad_task = tokio::spawn(async move {
        let (mut socket, _) = bad.accept().await.unwrap();
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt};
        let mut buffer = [0_u8; 4096];
        let _ = socket.read(&mut buffer).await.unwrap();
        let body = json!({"error":{"message":"fixture outage"}}).to_string();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let healthy = super::create(
        State(state.clone()),
        identity(&user),
        create(upstreams_input(
            "healthy",
            &format!("http://127.0.0.1:{good_port}/v1"),
            Some("sk-good"),
        )),
    )
    .await
    .unwrap()
    .0;
    let broken = super::create(
        State(state.clone()),
        identity(&user),
        create(upstreams_input(
            "broken",
            &format!("http://127.0.0.1:{bad_port}/v1"),
            Some("sk-bad"),
        )),
    )
    .await
    .unwrap()
    .0;

    let catalogs = super::models(State(state), identity(&user))
        .await
        .unwrap()
        .0;
    assert_eq!(catalogs.upstreams.len(), 2);
    let healthy_catalog = catalogs
        .upstreams
        .iter()
        .find(|entry| entry.id == healthy.id)
        .unwrap();
    assert_eq!(healthy_catalog.models, ["gpt-6-astra", "deepseek-flash"]);
    assert!(healthy_catalog.error.is_none());
    let broken_catalog = catalogs
        .upstreams
        .iter()
        .find(|entry| entry.id == broken.id)
        .unwrap();
    assert!(broken_catalog.models.is_empty());
    let error = broken_catalog.error.as_deref().unwrap();
    assert!(error.contains("503"), "{error}");
    good_task.await.unwrap();
    bad_task.await.unwrap();
}

fn upstreams_input(name: &str, base_url: &str, api_key: Option<&str>) -> CreateUpstreamInput {
    CreateUpstreamInput {
        name: name.to_owned(),
        base_url: base_url.to_owned(),
        api_key: api_key.map(str::to_owned),
    }
}

async fn bind_thread_to(state: &AppState, user: &User, thread_id: &str, upstream_id: &str) {
    let thread_id = thread_id.to_owned();
    let upstream_id = upstream_id.to_owned();
    user_db(state, user, false, move |connection| {
        connection.execute(
            "UPDATE threads SET upstream_id=? WHERE id=?",
            params![upstream_id, thread_id],
        )?;
        Ok(())
    })
    .await
    .unwrap();
}
