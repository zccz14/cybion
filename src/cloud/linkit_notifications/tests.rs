use super::super::tests::test_state;
use super::*;

#[derive(Clone)]
struct Bot {
    id: String,
    token: String,
}
struct MockLinkit {
    bot: Option<Bot>,
    owner: String,
    username: Option<String>,
    counterpart: String,
    calls: Vec<String>,
    messages: Vec<Value>,
    created: usize,
    rotated: usize,
    fault: Option<(usize, StatusCode, Value)>,
    send_status: StatusCode,
}

async fn mock_linkit(State(remote): State<Arc<Mutex<MockLinkit>>>, request: Request) -> Response {
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
    if let Some((n, status, value)) = &remote.fault
        && remote.calls.len() == *n
    {
        return (*status, Json(value.clone())).into_response();
    }
    if path == "/v1/responses" {
        return Json(json!({"id":"response-fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"task completed"}]}]})).into_response();
    }
    let human = bearer == "Bearer owner-auth-fixture";
    let bot = remote
        .bot
        .as_ref()
        .filter(|bot| bearer == format!("Bearer {}", bot.token))
        .cloned();
    if !human && bot.is_none() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if path == "/api/me" {
        return if human {
            Json(json!({"id":remote.owner,"profile":remote.username.as_ref().map(|username|json!({"username":username}))})).into_response()
        } else {
            Json(json!({"id":bot.unwrap().id,"profile":null})).into_response()
        };
    }
    if path == "/api/bots" {
        assert!(human);
        if method == reqwest::Method::GET {
            return Json(json!(
                remote
                    .bot
                    .iter()
                    .map(|b| json!({"id":b.id,"owner_user_id":remote.owner}))
                    .collect::<Vec<_>>()
            ))
            .into_response();
        }
        assert_eq!(body, json!({"name":"Cybion"}));
        remote.created += 1;
        let created = Bot {
            id: format!("created-{}", remote.created),
            token: format!("sk-created-{}", remote.created),
        };
        let result = json!({"id":created.id,"token":created.token});
        remote.bot = Some(created);
        return Json(result).into_response();
    }
    if path.starts_with("/api/bots/") {
        assert!(human);
        assert_eq!(method, reqwest::Method::PATCH);
        assert_eq!(body, json!({"rotate_token":true}));
        remote.rotated += 1;
        let token = format!("sk-rotated-{}", remote.rotated);
        let b = remote.bot.as_mut().unwrap();
        assert_eq!(path, format!("/api/bots/{}", b.id));
        b.token = token;
        return Json(json!({"id":b.id,"token":b.token})).into_response();
    }
    assert!(!human);
    if path.starts_with("/api/conversations/direct/") {
        return Json(
            json!({"id":"conversation-1","kind":"direct","counterpart_user_id":remote.counterpart}),
        )
        .into_response();
    }
    if path == "/api/conversations/conversation-1/messages" {
        assert_eq!(body["attachment_ids"], json!([]));
        assert_eq!(body["urgent"], false);
        if remote.send_status != StatusCode::OK {
            return (
                remote.send_status,
                Json(json!({"error":"fixture rejection"})),
            )
                .into_response();
        }
        remote.messages.push(body);
        return Json(json!({"id":format!("message-{}",remote.messages.len()),"conversation_id":"conversation-1","sender_id":bot.unwrap().id,"sender_kind":"bot"})).into_response();
    }
    panic!("unexpected Linkit route {path}; the removed /bot/v1/messages route must never be used");
}

struct Fixture {
    _root: tempfile::TempDir,
    state: AppState,
    user: User,
    remote: Arc<Mutex<MockLinkit>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture() -> Fixture {
    let (root, mut state) = test_state();
    let user = user_for_subject(&state, "notification-owner").unwrap();
    let remote = Arc::new(Mutex::new(MockLinkit {
        bot: Some(Bot {
            id: "bot-1".into(),
            token: "sk-bot-token".into(),
        }),
        owner: user.id.clone(),
        username: Some("owner".into()),
        counterpart: user.id.clone(),
        calls: vec![],
        messages: vec![],
        created: 0,
        rotated: 0,
        fault: None,
        send_status: StatusCode::OK,
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(mock_linkit)
        .with_state(remote.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    state.linkit_api_url = base.clone();
    let settings = IntegrationSettings {
        openai_consumer_id: "consumer".into(),
        openai_consumer_secret: "sk-model-fixture".into(),
        openai_base_url: format!("{base}/v1"),
        linkit_bot_id: "bot-1".into(),
        linkit_bot_token: "sk-bot-token".into(),
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
    }
}

fn identity(f: &Fixture) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: f.user.clone(),
        bearer: "owner-auth-fixture".into(),
    })
}
fn saved(f: &Fixture) -> IntegrationSettings {
    integration_settings(&open_user(&f.user.path, false).unwrap()).unwrap()
}
fn observed(f: &Fixture) -> NotificationStatus {
    status(&open_user(&f.user.path, false).unwrap()).unwrap()
}
async fn test_message(f: &Fixture) -> Result<Json<DeliveryReceipt>, ApiError> {
    super::test(State(f.state.clone()), identity(f)).await
}
async fn configure_notifications(f: &Fixture) -> Result<Json<NotificationStatus>, ApiError> {
    configure(State(f.state.clone()), identity(f)).await
}
async fn thread(f: &Fixture) -> ThreadView {
    create_thread_for(
        &f.state,
        &f.user,
        serde_json::from_value(json!({"title":"Notification fixture"})).unwrap(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn manual_test_uses_current_user_apis_and_persists_receipt_without_enabling_automatic_notifications()
 {
    let f = fixture().await;
    assert!(!observed(&f).enabled);
    let receipt = test_message(&f).await.unwrap().0;
    assert_eq!(receipt.id, "message-1");
    let view = observed(&f);
    assert!(!view.enabled);
    assert!(view.last_success_at.is_some());
    assert!(view.last_error.is_none());
    assert_eq!(view.message_id.as_deref(), Some("message-1"));
    assert_eq!(view.conversation_id.as_deref(), Some("conversation-1"));
    let remote = f.remote.lock().await;
    assert_eq!(
        remote.calls,
        vec![
            "GET /api/me",
            "POST /api/conversations/direct/owner",
            "POST /api/conversations/conversation-1/messages"
        ]
    );
    assert!(
        remote.messages[0]["body"]
            .as_str()
            .unwrap()
            .contains("通知测试")
    );
    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains("sk-bot-token"));
}

#[tokio::test]
async fn successful_and_failed_task_notifications_preserve_thread_link_after_long_details() {
    let f = fixture().await;
    set_enabled(&f.state, &f.user, true).await.unwrap();
    let t = thread(&f).await;
    for completed in [true, false] {
        notify(&f.state, &f.user, &t, completed, &"长内容".repeat(3000)).await;
    }
    let remote = f.remote.lock().await;
    assert_eq!(remote.messages.len(), 2);
    for (message, outcome) in remote.messages.iter().zip(["completed", "failed"]) {
        let body = message["body"].as_str().unwrap();
        assert!(body.contains(outcome));
        assert!(body.ends_with(&format!("/#/threads/{}", t.id)));
        assert!(body.len() < 4000);
    }
}

#[tokio::test]
async fn notifications_use_fresh_credentials_and_pausing_keeps_credentials_without_network_calls() {
    let f = fixture().await;
    let t = thread(&f).await;
    set_enabled(&f.state, &f.user, true).await.unwrap();
    let mut settings = saved(&f);
    settings.linkit_bot_token = "sk-refreshed-token".into();
    f.remote.lock().await.bot.as_mut().unwrap().token = settings.linkit_bot_token.clone();
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    notify(&f.state, &f.user, &t, true, "ok").await;
    assert_eq!(f.remote.lock().await.messages.len(), 1);
    assert!(
        !disable(State(f.state.clone()), identity(&f))
            .await
            .unwrap()
            .0
            .enabled
    );
    let before = f.remote.lock().await.calls.len();
    notify(&f.state, &f.user, &t, true, "paused").await;
    assert_eq!(f.remote.lock().await.calls.len(), before);
    assert_eq!(saved(&f).linkit_bot_token, "sk-refreshed-token");
}

#[tokio::test]
async fn delivery_http_failures_are_visible_and_do_not_claim_success_or_retry() {
    for rejected in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::NOT_FOUND,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let f = fixture().await;
        f.remote.lock().await.send_status = rejected;
        assert!(test_message(&f).await.is_err());
        let view = observed(&f);
        assert!(view.last_attempt_at.is_some());
        assert!(view.last_success_at.is_none());
        assert!(view.message_id.is_none());
        assert!(
            view.last_error
                .unwrap()
                .contains(&format!("HTTP {}", rejected.as_u16()))
        );
        assert_eq!(f.remote.lock().await.calls.len(), 3);
    }
}

#[tokio::test]
async fn stale_credentials_and_reassigned_recipient_do_not_send_thread_content() {
    let f = fixture().await;
    let mut settings = saved(&f);
    settings.linkit_bot_token = "sk-stale".into();
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    assert!(test_message(&f).await.is_err());
    assert!(f.remote.lock().await.messages.is_empty());
    settings.linkit_bot_token = "sk-bot-token".into();
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    f.remote.lock().await.counterpart = "another-user".into();
    assert_eq!(
        test_message(&f).await.unwrap_err().status,
        StatusCode::FORBIDDEN
    );
    let remote = f.remote.lock().await;
    assert!(!remote.calls.iter().any(|path| path.ends_with("/messages")));
    assert!(remote.messages.is_empty());
}

#[tokio::test]
async fn malformed_or_mismatched_receipts_are_not_reported_as_delivered() {
    for body in [
        json!({}),
        json!({"id":"","conversation_id":"conversation-1","sender_id":"bot-1","sender_kind":"bot"}),
        json!({"id":"message-1","conversation_id":"wrong","sender_id":"bot-1","sender_kind":"bot"}),
        json!({"id":"message-1","conversation_id":"conversation-1","sender_id":"wrong","sender_kind":"bot"}),
    ] {
        let f = fixture().await;
        f.remote.lock().await.fault = Some((3, StatusCode::OK, body));
        assert!(test_message(&f).await.is_err());
        assert!(observed(&f).last_success_at.is_none());
        assert!(observed(&f).last_error.is_some());
        assert_eq!(f.remote.lock().await.calls.len(), 3);
    }
}

#[tokio::test]
async fn configure_is_owner_scoped_repairs_stale_bot_token_and_preserves_openai_settings() {
    for stale in [false, true] {
        let f = fixture().await;
        let before = saved(&f);
        let mut settings = saved(&f);
        settings.linkit_username = "previous-username".into();
        if stale {
            settings.linkit_bot_token = "sk-stale".into();
        }
        save_integration_settings(&f.state, &f.user, &settings)
            .await
            .unwrap();
        let view = configure_notifications(&f).await.unwrap().0;
        assert!(view.enabled && view.configured);
        assert!(view.last_success_at.is_none());
        let after = saved(&f);
        assert_eq!(after.linkit_username, "owner");
        assert_eq!(after.openai_consumer_secret, before.openai_consumer_secret);
        assert_eq!(after.openai_base_url, before.openai_base_url);
        let remote = f.remote.lock().await;
        assert_eq!(remote.rotated, usize::from(stale));
        assert_eq!(remote.created, 0);
        assert_eq!(after.linkit_bot_token, remote.bot.as_ref().unwrap().token);
    }
    let f = fixture().await;
    f.remote.lock().await.owner = "different-owner".into();
    assert_eq!(
        configure_notifications(&f).await.unwrap_err().status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(f.remote.lock().await.calls.len(), 1);
}

#[tokio::test]
async fn deleted_bot_recreation_and_parallel_configuration_create_only_one_bot() {
    let f = fixture().await;
    f.remote.lock().await.bot = None;
    let (a, b) = tokio::join!(configure_notifications(&f), configure_notifications(&f));
    assert!(a.unwrap().0.enabled);
    assert!(b.unwrap().0.enabled);
    assert_eq!(f.remote.lock().await.created, 1);
    assert_eq!(f.remote.lock().await.rotated, 0);
    assert_eq!(saved(&f).linkit_bot_id, "created-1");
}

#[tokio::test]
async fn new_bot_token_is_saved_before_final_validation_failure_and_reused_on_retry() {
    let f = fixture().await;
    {
        let mut remote = f.remote.lock().await;
        remote.bot = None;
        remote.fault = Some((4, StatusCode::SERVICE_UNAVAILABLE, json!({})));
    }
    assert!(configure_notifications(&f).await.is_err());
    assert_eq!(saved(&f).linkit_bot_token, "sk-created-1");
    assert!(!observed(&f).enabled);
    assert!(configure_notifications(&f).await.unwrap().0.enabled);
    assert_eq!(f.remote.lock().await.created, 1);
}

#[tokio::test]
async fn linkit_setup_failure_does_not_block_openai_readiness_or_clear_credentials() {
    let f = fixture().await;
    f.remote.lock().await.username = None;
    assert!(configure_notifications(&f).await.is_err());
    assert_eq!(saved(&f).linkit_bot_token, "sk-bot-token");
    assert!(openai_integration_ready(
        &required_openai_integration(&f.state, &f.user)
            .await
            .unwrap()
    ));
    ensure_openai_integration(&f.state, &f.user, "owner-auth-fixture")
        .await
        .unwrap();
    assert_eq!(f.remote.lock().await.calls.len(), 1);
}

#[tokio::test]
async fn transport_failure_is_recorded_without_unbounded_wait_or_retry() {
    let mut f = fixture().await;
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    f.state.client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", proxy.local_addr().unwrap())).unwrap())
        .read_timeout(Duration::from_millis(50))
        .build()
        .unwrap();
    assert!(test_message(&f).await.is_err());
    assert!(observed(&f).last_error.is_some());
    assert!(f.remote.lock().await.calls.is_empty());
}

#[tokio::test]
async fn schema_14_preserves_existing_notification_intent_but_new_users_start_disabled() {
    let f = fixture().await;
    assert!(!observed(&f).enabled);
    let connection = open_user(&f.user.path, false).unwrap();
    connection
        .execute_batch("DROP TABLE notification_settings; PRAGMA user_version=13;")
        .unwrap();
    drop(connection);
    assert!(observed(&f).enabled);
    assert_eq!(saved(&f).linkit_bot_token, "sk-bot-token");
    let _ = disable(State(f.state.clone()), identity(&f)).await.unwrap();
    assert!(!observed(&f).enabled);
    assert!(!observed(&f).enabled);
    let other = user_for_subject(&f.state, "new-notification-user").unwrap();
    let c = open_user(&other.path, true).unwrap();
    assert!(!status(&c).unwrap().enabled);
}

#[tokio::test]
async fn completed_thread_stays_successful_when_notification_delivery_fails() {
    let f = fixture().await;
    set_enabled(&f.state, &f.user, true).await.unwrap();
    f.remote.lock().await.send_status = StatusCode::SERVICE_UNAVAILABLE;
    let t = thread(&f).await;
    enqueue_request(
        f.state.clone(),
        f.user.clone(),
        t.id.clone(),
        "finish the fixture".into(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while observed(&f).last_attempt_at.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let completed = load_thread(&open_user(&f.user.path, false).unwrap(), &t.id).unwrap();
    assert_eq!(completed.status, "idle");
    assert_eq!(completed.display_status, "completed");
    assert!(observed(&f).last_error.unwrap().contains("HTTP 503"));
}

#[tokio::test]
async fn missing_openai_credentials_still_allow_an_independent_failure_notification() {
    let f = fixture().await;
    set_enabled(&f.state, &f.user, true).await.unwrap();
    let mut settings = saved(&f);
    settings.openai_consumer_secret.clear();
    save_integration_settings(&f.state, &f.user, &settings)
        .await
        .unwrap();
    let t = thread(&f).await;
    enqueue_request(
        f.state.clone(),
        f.user.clone(),
        t.id.clone(),
        "fail the fixture".into(),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while observed(&f).last_success_at.is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let failed = load_thread(&open_user(&f.user.path, false).unwrap(), &t.id).unwrap();
    assert_eq!(failed.status, "failed");
    assert!(
        f.remote.lock().await.messages[0]["body"]
            .as_str()
            .unwrap()
            .contains("failed / 失败")
    );
}

#[tokio::test]
async fn notification_management_routes_reject_missing_browser_authentication() {
    let f = fixture().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = app(f.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for (method, path) in [
        (reqwest::Method::GET, "/api/integrations/linkit"),
        (reqwest::Method::DELETE, "/api/integrations/linkit"),
        (reqwest::Method::POST, "/api/integrations/linkit/refresh"),
        (reqwest::Method::POST, "/api/integrations/linkit/test"),
    ] {
        let response = reqwest::Client::new()
            .request(method, format!("{base}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert!(f.remote.lock().await.calls.is_empty());
    server.abort();
}

#[tokio::test]
async fn parallel_linkit_and_openai_saves_do_not_overwrite_the_other_credentials() {
    let f = fixture().await;
    let mut linkit = saved(&f);
    let mut openai = saved(&f);
    linkit.linkit_bot_token = "sk-new-linkit".into();
    linkit.linkit_username = "new-name".into();
    openai.openai_consumer_secret = "sk-new-openai".into();
    let (a, b) = tokio::join!(
        save_settings(&f.state, &f.user, &linkit),
        openai_integration::save(&f.state, &f.user, &openai)
    );
    a.unwrap();
    b.unwrap();
    let result = saved(&f);
    assert_eq!(result.linkit_bot_token, "sk-new-linkit");
    assert_eq!(result.linkit_username, "new-name");
    assert_eq!(result.openai_consumer_secret, "sk-new-openai");
}
