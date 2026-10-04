use super::tests::{insert_upstream, test_state};
use super::*;
use crate::cloud::upstreams::UpstreamView;

struct MockNormai {
    consumers: Vec<Value>,
    calls: Vec<String>,
    created: usize,
    rotated: usize,
    list_status: StatusCode,
}

async fn mock_normai(State(remote): State<Arc<Mutex<MockNormai>>>, request: Request) -> Response {
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
    if path == "/api/consumers" && method == reqwest::Method::GET {
        if remote.list_status != StatusCode::OK {
            return (
                remote.list_status,
                Json(json!({"error":"fixture rejection"})),
            )
                .into_response();
        }
        return Json(Value::Array(remote.consumers.clone())).into_response();
    }
    if path == "/api/consumers" && method == reqwest::Method::POST {
        assert_eq!(body["name"], json!("Cybion"));
        assert_eq!(body["request_archive"], json!(false));
        remote.created += 1;
        let created = remote.created;
        let consumer_id = format!("consumer-{created}");
        remote
            .consumers
            .push(json!({"id": consumer_id, "name": "Cybion"}));
        return Json(json!({
            "id": consumer_id,
            "name": "Cybion",
            "prefix": "sk-created",
            "secret": format!("sk-created-{created}"),
            "request_archive": false,
            "is_disabled": false
        }))
        .into_response();
    }
    if let Some(id) = path
        .strip_prefix("/api/consumers/")
        .and_then(|rest| rest.strip_suffix("/rotate"))
    {
        assert_eq!(method, reqwest::Method::POST);
        assert!(
            remote
                .consumers
                .iter()
                .any(|consumer| consumer["id"] == json!(id)),
            "rotating an unknown consumer"
        );
        remote.rotated += 1;
        let rotated = remote.rotated;
        return Json(
            json!({"id": id, "prefix": "sk-rotated", "secret": format!("sk-rotated-{rotated}")}),
        )
        .into_response();
    }
    panic!("unexpected NormAI route {method} {path}");
}

struct NormaiFixture {
    _root: tempfile::TempDir,
    state: AppState,
    user: User,
    remote: Arc<Mutex<MockNormai>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for NormaiFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture() -> NormaiFixture {
    let (root, mut state) = test_state();
    let user = user_for_subject(&state, "normai-owner").unwrap();
    let remote = Arc::new(Mutex::new(MockNormai {
        consumers: Vec::new(),
        calls: Vec::new(),
        created: 0,
        rotated: 0,
        list_status: StatusCode::OK,
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    state.normai_api_url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(mock_normai)
        .with_state(remote.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    NormaiFixture {
        _root: root,
        state,
        user,
        remote,
        server,
    }
}

fn identity(f: &NormaiFixture) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: f.user.clone(),
        bearer: "owner-auth-fixture".into(),
    })
}

async fn connect(f: &NormaiFixture) -> UpstreamView {
    normai::connect(State(f.state.clone()), identity(f))
        .await
        .unwrap()
        .0
}

async fn rotate(f: &NormaiFixture) -> UpstreamView {
    normai::rotate(State(f.state.clone()), identity(f))
        .await
        .unwrap()
        .0
}

async fn upstreams_of(f: &NormaiFixture) -> Vec<Upstream> {
    user_db(&f.state, &f.user, true, |connection| {
        upstreams::load_all(connection)
    })
    .await
    .unwrap()
}

async fn default_upstream(f: &NormaiFixture) -> Option<String> {
    user_db(&f.state, &f.user, true, |connection| {
        Ok(connection
            .query_row(
                "SELECT upstream_id FROM thread_defaults WHERE id=1",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })
    .await
    .unwrap()
}

async fn set_default_upstream(f: &NormaiFixture, id: &str) {
    let id = id.to_owned();
    user_db(&f.state, &f.user, true, move |connection| {
        connection.execute(
            "INSERT INTO thread_defaults(id,model,upstream_id,reasoning_effort,service_tier_fast,context_budget_tokens,minimal_mode) VALUES(1,?,?,?,0,?,0)
             ON CONFLICT(id) DO UPDATE SET upstream_id=excluded.upstream_id",
            params![DEFAULT_MODEL, id, "medium", DEFAULT_CONTEXT_BUDGET_TOKENS],
        )?;
        Ok(())
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn connect_creates_the_consumer_and_binds_it_as_the_default_upstream() {
    let f = fixture().await;
    let view = connect(&f).await;
    assert!(view.api_key_configured);
    assert_eq!(view.name, "NormAI");
    assert_eq!(view.base_url, "https://normai.ntnl.io/v1");
    let upstreams = upstreams_of(&f).await;
    assert_eq!(upstreams.len(), 1);
    assert_eq!(upstreams[0].id, view.id);
    assert_eq!(upstreams[0].api_key, "sk-created-1");
    assert_eq!(
        default_upstream(&f).await.as_deref(),
        Some(upstreams[0].id.as_str())
    );
    {
        let remote = f.remote.lock().await;
        assert_eq!(
            remote.calls,
            vec![
                "GET /api/consumers Bearer owner-auth-fixture".to_owned(),
                "POST /api/consumers Bearer owner-auth-fixture".to_owned(),
            ]
        );
        assert_eq!(remote.created, 1);
    }

    // The automatic call repeats on every workspace load: a stored credential
    // is kept as-is and NormAI is not contacted again.
    let again = connect(&f).await;
    assert_eq!(again.id, view.id);
    assert_eq!(f.remote.lock().await.calls.len(), 2);
    assert_eq!(upstreams_of(&f).await.len(), 1);
}

#[tokio::test]
async fn connect_rotates_the_existing_cybion_consumer_instead_of_creating_another() {
    let f = fixture().await;
    f.remote
        .lock()
        .await
        .consumers
        .push(json!({"id": "consumer-9", "name": "Cybion"}));
    let view = connect(&f).await;
    let upstreams = upstreams_of(&f).await;
    assert_eq!(upstreams.len(), 1);
    assert_eq!(upstreams[0].id, view.id);
    assert_eq!(upstreams[0].api_key, "sk-rotated-1");
    let remote = f.remote.lock().await;
    assert_eq!(remote.created, 0);
    assert_eq!(remote.rotated, 1);
    assert_eq!(remote.consumers.len(), 1);
    assert_eq!(
        remote.calls,
        vec![
            "GET /api/consumers Bearer owner-auth-fixture".to_owned(),
            "POST /api/consumers/consumer-9/rotate Bearer owner-auth-fixture".to_owned(),
        ]
    );
}

#[tokio::test]
async fn rotate_reissues_the_credential_and_recovers_a_vanished_consumer() {
    let f = fixture().await;
    let first = connect(&f).await;
    let rotated = rotate(&f).await;
    assert_eq!(rotated.id, first.id);
    assert_eq!(upstreams_of(&f).await[0].api_key, "sk-rotated-1");
    assert_eq!(f.remote.lock().await.created, 1);

    // The consumer vanished on NormAI (deleted by hand): rotating issues a
    // replacement instead of failing, and never adds a second upstream row.
    f.remote.lock().await.consumers.clear();
    let recreated = rotate(&f).await;
    assert_eq!(recreated.id, first.id);
    let upstreams = upstreams_of(&f).await;
    assert_eq!(upstreams.len(), 1);
    assert_eq!(upstreams[0].api_key, "sk-created-2");
    assert_eq!(f.remote.lock().await.created, 2);
}

#[tokio::test]
async fn connect_keeps_an_existing_default_upstream() {
    let f = fixture().await;
    let other = insert_upstream(
        &f.state,
        &f.user,
        "DeepSeek",
        "https://api.deepseek.example/v1",
    )
    .await;
    set_default_upstream(&f, &other.id).await;
    connect(&f).await;
    let upstreams = upstreams_of(&f).await;
    assert_eq!(upstreams.len(), 2);
    assert_eq!(
        upstreams
            .iter()
            .find(|upstream| upstream.id != other.id)
            .unwrap()
            .api_key,
        "sk-created-1"
    );
    assert_eq!(
        default_upstream(&f).await.as_deref(),
        Some(other.id.as_str())
    );
}

#[tokio::test]
async fn normai_failures_leave_the_local_configuration_untouched() {
    let f = fixture().await;
    f.remote.lock().await.list_status = StatusCode::INTERNAL_SERVER_ERROR;
    let error = normai::connect(State(f.state.clone()), identity(&f))
        .await
        .unwrap_err();
    assert!(
        error
            .message
            .contains("NormAI list consumers failed (HTTP 500)")
    );
    assert!(upstreams_of(&f).await.is_empty());
    assert!(default_upstream(&f).await.is_none());

    f.remote.lock().await.list_status = StatusCode::UNAUTHORIZED;
    let error = normai::connect(State(f.state.clone()), identity(&f))
        .await
        .unwrap_err();
    assert!(error.message.contains("sign in again"));
    assert!(upstreams_of(&f).await.is_empty());
}
