use super::super::tests::test_state;
use super::*;

#[derive(Clone)]
struct Consumer {
    id: String,
    secret: String,
    disabled: bool,
    archive: bool,
}

fn consumer() -> Consumer {
    Consumer {
        id: "owned-consumer".into(),
        secret: "sk-current-fixture".into(),
        disabled: false,
        archive: true,
    }
}

#[derive(Default)]
struct MockLb {
    consumer: Option<Consumer>,
    calls: Vec<String>,
    created: usize,
    rotated: usize,
    fault: Option<(usize, StatusCode, Value)>,
}

async fn mock_lb(State(remote): State<Arc<Mutex<MockLb>>>, request: Request) -> Response {
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
    remote.calls.push(format!("{method} {path}"));
    if let Some((index, status, body)) = &remote.fault
        && remote.calls.len() == *index
    {
        return (*status, Json(body.clone())).into_response();
    }
    if path == "/v1/responses" {
        let authenticated = remote
            .consumer
            .as_ref()
            .is_some_and(|c| !c.disabled && bearer == format!("Bearer {}", c.secret));
        return if authenticated {
            Json(json!({"id":"resp-fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]})).into_response()
        } else {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":{"message":"invalid consumer credential"}})),
            )
                .into_response()
        };
    }
    assert_eq!(bearer, "Bearer owner-auth-fixture");
    if path == "/api/me" {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if method == reqwest::Method::POST && path == "/api/consumers" {
        assert_eq!(
            body,
            json!({"name":INTEGRATION_NAME,"request_archive":true})
        );
        remote.created += 1;
        let consumer = Consumer {
            id: format!("created-{}", remote.created),
            secret: format!("sk-created-{}", remote.created),
            disabled: false,
            archive: true,
        };
        let grant = json!({"id":consumer.id,"secret":consumer.secret});
        remote.consumer = Some(consumer);
        return Json(grant).into_response();
    }
    let target = path.strip_prefix("/api/consumers/").unwrap();
    let (id, action) = target.split_once('/').unwrap_or((target, ""));
    let Some(consumer) = remote
        .consumer
        .as_ref()
        .filter(|consumer| consumer.id == id)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match (method, action) {
        (reqwest::Method::POST, "verify") => Json(json!({"id":id,"credential_matches":body["secret"] == consumer.secret,"is_disabled":consumer.disabled,"request_archive":consumer.archive})).into_response(),
        (reqwest::Method::POST, "rotate") => {
            remote.rotated += 1;
            let secret = format!("sk-rotated-{}", remote.rotated);
            remote.consumer.as_mut().unwrap().secret = secret.clone();
            Json(json!({"id":id,"secret":secret})).into_response()
        }
        (reqwest::Method::PATCH, "") => {
            assert_eq!(body, json!({"is_disabled":false}));
            let consumer = remote.consumer.as_mut().unwrap();
            consumer.disabled = false;
            Json(json!({"id":id,"is_disabled":false,"request_archive":consumer.archive})).into_response()
        }
        _ => panic!("unexpected mock request {path}"),
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    state: AppState,
    user: User,
    remote: Arc<Mutex<MockLb>>,
    server: tokio::task::JoinHandle<()>,
    base: String,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture(consumer: Option<Consumer>) -> Fixture {
    let (root, mut state) = test_state();
    let remote = Arc::new(Mutex::new(MockLb {
        consumer,
        ..Default::default()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(mock_lb).with_state(remote.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state.openai_consumers_url = format!("{base}/api/consumers");
    state.linkit_api_url = base.clone();
    let user = user_for_subject(&state, "owner-fixture").unwrap();
    let settings = IntegrationSettings {
        openai_consumer_id: "owned-consumer".into(),
        openai_consumer_secret: "sk-stale-fixture".into(),
        openai_base_url: OPENAI_BASE_URL.into(),
        linkit_bot_id: "bot".into(),
        linkit_bot_token: "bot-token".into(),
        linkit_username: "owner".into(),
    };
    save_integration_settings(&state, &user, &settings)
        .await
        .unwrap();
    Fixture {
        _root: root,
        state,
        user,
        remote,
        server,
        base,
    }
}

fn stored(f: &Fixture) -> IntegrationSettings {
    integration_settings(&open_user(&f.user.path, false).unwrap()).unwrap()
}

async fn refresh(f: &Fixture) -> Result<Json<IntegrationStatusView>, ApiError> {
    refresh_integrations(
        State(f.state.clone()),
        axum::Extension(BrowserIdentity {
            user: f.user.clone(),
            bearer: "owner-auth-fixture".into(),
        }),
    )
    .await
}

async fn inference(f: &Fixture) -> Result<ResponsesResult, ApiError> {
    let mut settings = stored(f);
    settings.openai_base_url = format!("{}/v1", f.base);
    send_responses_request(
        &f.state,
        &settings,
        "test-model",
        None,
        false,
        json!([]),
        false,
        false,
        None,
        None,
        None,
    )
    .await
}

async fn assert_synchronized(f: &Fixture) {
    let saved = stored(f);
    let remote = f.remote.lock().await;
    let consumer = remote.consumer.as_ref().unwrap();
    assert_eq!(saved.openai_consumer_id, consumer.id);
    assert_eq!(saved.openai_consumer_secret, consumer.secret);
    assert_eq!(saved.openai_base_url, OPENAI_BASE_URL);
    assert!(!consumer.disabled);
}

#[tokio::test]
async fn rotated_token_401_is_repaired_and_healthy_refresh_does_not_rotate_again() {
    let f = fixture(Some(consumer())).await;
    let error = inference(&f).await.err().unwrap();
    assert!(error.message.contains("HTTP 401"));
    assert!(error.message.contains("refresh the OpenAI-LB integration"));
    assert_eq!(error.kind, ApiErrorKind::Ordinary);
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    assert_synchronized(&f).await;
    assert!(inference(&f).await.is_ok());
    let secret = stored(&f).openai_consumer_secret;
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    assert_eq!(stored(&f).openai_consumer_secret, secret);
    let remote = f.remote.lock().await;
    assert_eq!(remote.rotated, 1);
    assert_eq!(remote.created, 0);
    let requests = remote.calls.len();
    drop(remote);
    ensure_integrations(&f.state, &f.user, "owner-auth-fixture")
        .await
        .unwrap();
    assert_eq!(f.remote.lock().await.calls.len(), requests);
}

#[tokio::test]
async fn deleted_consumer_is_recreated_once_and_inference_recovers() {
    let f = fixture(None).await;
    assert!(inference(&f).await.is_err());
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    assert_synchronized(&f).await;
    assert!(inference(&f).await.is_ok());
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    let remote = f.remote.lock().await;
    assert_eq!(remote.created, 1);
    assert_eq!(remote.rotated, 0);
}

#[tokio::test]
async fn missing_local_token_rotates_existing_consumer_instead_of_creating_duplicate() {
    let f = fixture(Some(consumer())).await;
    let mut settings = stored(&f);
    settings.openai_consumer_secret.clear();
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    let (initial, refreshed) = tokio::join!(
        ensure_integrations(&f.state, &f.user, "owner-auth-fixture"),
        refresh(&f)
    );
    initial.unwrap();
    assert!(refreshed.unwrap().0.openai_configured);
    assert_synchronized(&f).await;
    let remote = f.remote.lock().await;
    assert_eq!(remote.rotated, 1);
    assert_eq!(remote.created, 0);
}

#[tokio::test]
async fn missing_local_id_provisions_and_is_not_reported_as_configured_beforehand() {
    let f = fixture(None).await;
    let mut settings = stored(&f);
    settings.openai_consumer_id.clear();
    assert!(
        !integration_status_view(
            &settings,
            &GlobalRequestHeaders {
                user_agent: String::new(),
                originator: String::new()
            }
        )
        .openai_configured
    );
    assert!(!integrations_ready(&settings));
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    assert_synchronized(&f).await;
    assert_eq!(f.remote.lock().await.created, 1);
}

#[tokio::test]
async fn explicit_refresh_reenables_consumer_and_preserves_a_matching_token() {
    for secret in ["sk-current-fixture", "sk-stale-fixture"] {
        let mut remote_consumer = consumer();
        remote_consumer.disabled = true;
        remote_consumer.archive = false;
        let f = fixture(Some(remote_consumer)).await;
        let mut settings = stored(&f);
        settings.openai_consumer_secret = secret.into();
        save_integration_settings(&f.state, &f.user, &settings)
            .await
            .unwrap();
        assert!(refresh(&f).await.unwrap().0.openai_configured);
        assert_synchronized(&f).await;
        let remote = f.remote.lock().await;
        assert_eq!(remote.rotated, usize::from(secret != "sk-current-fixture"));
        assert_eq!(remote.created, 0);
        assert!(!remote.consumer.as_ref().unwrap().archive);
        assert!(
            remote
                .calls
                .contains(&"PATCH /api/consumers/owned-consumer".into())
        );
    }
}

#[tokio::test]
async fn verification_errors_preserve_local_credentials_and_never_create_consumers() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        let f = fixture(Some(consumer())).await;
        f.remote.lock().await.fault = Some((1, status, json!({"error":"fixture failure"})));
        assert!(refresh(&f).await.is_err());
        assert_eq!(stored(&f).openai_consumer_secret, "sk-stale-fixture");
        let remote = f.remote.lock().await;
        assert_eq!(remote.calls.len(), 1);
        assert_eq!(remote.created, 0);
        assert_eq!(remote.rotated, 0);
    }
}

#[tokio::test]
async fn unreachable_lb_cannot_report_refresh_success() {
    let mut f = fixture(Some(consumer())).await;
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    f.state.client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", proxy.local_addr().unwrap())).unwrap())
        .connect_timeout(Duration::from_millis(50))
        .read_timeout(Duration::from_millis(50))
        .build()
        .unwrap();
    assert!(refresh(&f).await.is_err());
    assert_eq!(stored(&f).openai_consumer_secret, "sk-stale-fixture");
    assert!(f.remote.lock().await.calls.is_empty());
}

#[tokio::test]
async fn new_credentials_survive_linkit_failure_and_are_reused_on_retry() {
    for remote_consumer in [None, Some(consumer())] {
        let f = fixture(remote_consumer).await;
        let mut settings = stored(&f);
        settings.linkit_username.clear();
        save_integration_settings(&f.state, &f.user, &settings)
            .await
            .unwrap();
        assert!(refresh(&f).await.is_err());
        assert_synchronized(&f).await;
        let secret = stored(&f).openai_consumer_secret;
        let mut settings = stored(&f);
        settings.linkit_username = "owner".into();
        save_integration_settings(&f.state, &f.user, &settings)
            .await
            .unwrap();
        assert!(refresh(&f).await.unwrap().0.openai_configured);
        assert_eq!(stored(&f).openai_consumer_secret, secret);
        let remote = f.remote.lock().await;
        assert_eq!(remote.created + remote.rotated, 1);
    }
}

#[tokio::test]
async fn final_verification_must_confirm_the_same_active_consumer_and_full_token() {
    for (status, body) in [
        (StatusCode::NOT_FOUND, json!({})),
        (
            StatusCode::OK,
            json!({"id":"owned-consumer","credential_matches":false,"is_disabled":false,"request_archive":true}),
        ),
        (
            StatusCode::OK,
            json!({"id":"owned-consumer","credential_matches":true,"is_disabled":true,"request_archive":true}),
        ),
        (
            StatusCode::OK,
            json!({"id":"different-consumer","credential_matches":true,"is_disabled":false,"request_archive":true}),
        ),
        (StatusCode::OK, json!({"unexpected":"schema"})),
    ] {
        let f = fixture(Some(consumer())).await;
        f.remote.lock().await.fault = Some((3, status, body));
        assert!(refresh(&f).await.is_err());
        assert_eq!(stored(&f).openai_consumer_secret, "sk-rotated-1");
        assert!(refresh(&f).await.unwrap().0.openai_configured);
        assert_synchronized(&f).await;
        assert_eq!(f.remote.lock().await.rotated, 1);
    }
}

#[tokio::test]
async fn concurrent_refreshes_repair_once_and_keep_remote_and_local_tokens_equal() {
    for remote_consumer in [None, Some(consumer())] {
        let f = fixture(remote_consumer).await;
        let (first, second, third) = tokio::join!(refresh(&f), refresh(&f), refresh(&f));
        assert!(first.unwrap().0.openai_configured);
        assert!(second.unwrap().0.openai_configured);
        assert!(third.unwrap().0.openai_configured);
        assert_synchronized(&f).await;
        let remote = f.remote.lock().await;
        assert_eq!(remote.created + remote.rotated, 1);
    }
}

#[tokio::test]
async fn invalid_grants_are_not_saved_or_reported_as_success() {
    for (remote_consumer, index, grant) in [
        (
            Some(consumer()),
            2,
            json!({"id":"foreign","secret":"sk-unrelated"}),
        ),
        (
            Some(consumer()),
            2,
            json!({"id":"owned-consumer","secret":""}),
        ),
        (None, 2, json!({"id":"","secret":"sk-created"})),
        (None, 2, json!({"id":"created-1","secret":"invalid"})),
    ] {
        let f = fixture(remote_consumer).await;
        f.remote.lock().await.fault = Some((index, StatusCode::OK, grant));
        assert!(refresh(&f).await.is_err());
        assert_eq!(stored(&f).openai_consumer_secret, "sk-stale-fixture");
    }
}

#[tokio::test]
async fn local_persistence_failure_does_not_report_success_and_next_refresh_can_repair() {
    let f = fixture(Some(consumer())).await;
    open_user(&f.user.path, false).unwrap().execute_batch("CREATE TRIGGER reject_new_secret BEFORE UPDATE OF openai_consumer_secret ON integration_settings WHEN NEW.openai_consumer_secret != OLD.openai_consumer_secret BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;").unwrap();
    assert!(refresh(&f).await.is_err());
    assert_eq!(stored(&f).openai_consumer_secret, "sk-stale-fixture");
    open_user(&f.user.path, false)
        .unwrap()
        .execute_batch("DROP TRIGGER reject_new_secret;")
        .unwrap();
    assert!(refresh(&f).await.unwrap().0.openai_configured);
    assert_synchronized(&f).await;
}

#[tokio::test]
async fn refresh_preserves_an_existing_consumers_archive_preference() {
    for disabled in [false, true] {
        let mut current = consumer();
        current.disabled = disabled;
        current.archive = false;
        let f = fixture(Some(current)).await;
        let mut settings = stored(&f);
        settings.openai_consumer_secret = "sk-current-fixture".into();
        save_integration_settings(&f.state, &f.user, &settings)
            .await
            .unwrap();
        assert!(refresh(&f).await.unwrap().0.openai_configured);
        assert_synchronized(&f).await;
        let remote = f.remote.lock().await;
        assert!(!remote.consumer.as_ref().unwrap().archive);
        assert_eq!(remote.rotated, 0);
        assert_eq!(
            remote
                .calls
                .iter()
                .filter(|call| call.starts_with("PATCH "))
                .count(),
            usize::from(disabled)
        );
    }
}
