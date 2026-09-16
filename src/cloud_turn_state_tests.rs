use super::tests::{create_test_thread, test_state};
use super::*;
use std::collections::VecDeque;

fn reply(value: Option<&str>, streaming: bool, status: StatusCode) -> Response {
    let body = json!({"id":"fixture","output":[]});
    let (content_type, body) = if streaming {
        (
            "text/event-stream",
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({"type":"response.completed","response":body})
            ),
        )
    } else {
        ("application/json", body.to_string())
    };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type);
    if let Some(value) = value {
        response = response.header("X-Codex-Turn-State", value);
    }
    response.body(Body::from(body)).unwrap()
}

async fn upstream(
    replies: Vec<Response>,
) -> (
    IntegrationSettings,
    tokio::sync::mpsc::UnboundedReceiver<HeaderMap>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    let (sent, received) = tokio::sync::mpsc::unbounded_channel();
    let router = Router::new().route(
        "/responses",
        post(move |headers: HeaderMap, _: Json<Value>| {
            let sent = sent.clone();
            let replies = replies.clone();
            async move {
                sent.send(headers).unwrap();
                replies
                    .lock()
                    .await
                    .pop_front()
                    .expect("unexpected request")
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (
        IntegrationSettings {
            openai_consumer_id: "consumer".to_owned(),
            openai_consumer_secret: "secret".to_owned(),
            openai_base_url: format!("http://{address}"),
            linkit_bot_id: String::new(),
            linkit_bot_token: String::new(),
            linkit_username: String::new(),
        },
        received,
        server,
    )
}

async fn send(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    integrations: &IntegrationSettings,
) -> Result<ResponsesResult, ApiError> {
    let thread_id = thread.id.clone();
    let input = user_db(state, user, false, move |connection| {
        Ok(super::tests::insert_record(
            connection,
            &thread_id,
            "input",
            json!({"role":"user","content":"hello"}),
        ))
    })
    .await?;
    responses_request_with_options(
        state,
        user,
        &thread.id,
        Some(input),
        "inference",
        input,
        input,
        integrations,
        &thread.model,
        None,
        false,
        json!([{"role":"user","content":"hello"}]),
        false,
        None,
        None,
        None,
    )
    .await
}

fn enabled(state: &AppState, value: bool) {
    set_admin_meta_bool_sync(
        &state.admin_db_path,
        EXPERIMENTAL_CODEX_TURN_STATE_HEADER_KEY,
        value,
    )
    .unwrap();
}

async fn assert_header(
    received: &mut tokio::sync::mpsc::UnboundedReceiver<HeaderMap>,
    expected: Option<&str>,
) {
    let headers = received.recv().await.unwrap();
    assert_eq!(
        headers
            .get(CODEX_TURN_STATE_HEADER)
            .map(|value| value.to_str().unwrap()),
        expected,
    );
    assert!(!headers.contains_key(THREAD_ID_HEADER));
}

#[tokio::test]
async fn codex_turn_state_round_trips_latest_json_and_sse_headers_only_when_enabled() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "turn-state-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let (integrations, mut received, server) = upstream(vec![
        reply(Some("ignored-by-default"), false, StatusCode::OK),
        reply(Some("opaque.A+/="), false, StatusCode::OK),
        reply(Some("opaque.B+/="), true, StatusCode::OK),
        reply(None, false, StatusCode::OK),
        reply(Some("ignored-while-disabled"), false, StatusCode::OK),
        reply(Some("retry-state"), false, StatusCode::TOO_MANY_REQUESTS),
        reply(None, false, StatusCode::OK),
    ])
    .await;

    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, None).await;
    enabled(&state, true);
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, None).await;
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, Some("opaque.A+/=")).await;
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, Some("opaque.B+/=")).await;
    enabled(&state, false);
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, None).await;
    enabled(&state, true);
    assert!(send(&state, &user, &thread, &integrations).await.is_err());
    assert_header(&mut received, Some("opaque.B+/=")).await;
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, Some("retry-state")).await;

    // Reopening the database must preserve the state independently of the HTTP client.
    let connection = open_user(&user.path, false).unwrap();
    let stored: Vec<u8> = connection
        .query_row(
            "SELECT value FROM thread_turn_states WHERE thread_id=?",
            [&thread.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, b"retry-state");
    connection
        .execute("DELETE FROM threads WHERE id=?", [&thread.id])
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM thread_turn_states", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    server.abort();
}

#[tokio::test]
async fn codex_turn_state_is_isolated_by_thread_user_and_upstream() {
    let (_root, state) = test_state();
    enabled(&state, true);
    let user = user_for_subject(&state, "first-owner").unwrap();
    let other_user = user_for_subject(&state, "second-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let other_thread = create_test_thread(&state, &user).await;
    let mut same_id_thread = create_test_thread(&state, &other_user).await;
    open_user(&other_user.path, false)
        .unwrap()
        .execute(
            "UPDATE threads SET id=? WHERE id=?",
            params![thread.id, same_id_thread.id],
        )
        .unwrap();
    same_id_thread.id = thread.id.clone();
    let (mut integrations, mut received, server) = upstream(vec![
        reply(Some("first-thread"), false, StatusCode::OK),
        reply(Some("other-thread"), false, StatusCode::OK),
        reply(Some("other-user"), false, StatusCode::OK),
        reply(None, false, StatusCode::OK),
        reply(None, false, StatusCode::OK),
    ])
    .await;
    for (owner, target, expected) in [
        (&user, &thread, None),
        (&user, &other_thread, None),
        (&other_user, &same_id_thread, None),
        (&user, &thread, Some("first-thread")),
    ] {
        send(&state, owner, target, &integrations).await.unwrap();
        assert_header(&mut received, expected).await;
    }
    integrations.openai_consumer_secret = "rotated-secret".to_owned();
    send(&state, &user, &thread, &integrations).await.unwrap();
    assert_header(&mut received, None).await;

    let (mut other_upstream, mut other_received, other_server) = upstream(vec![
        reply(Some("unscoped-response"), false, StatusCode::OK),
        reply(None, false, StatusCode::OK),
    ])
    .await;
    other_upstream.openai_consumer_secret = "secret".to_owned();
    responses_request(
        &state,
        &other_upstream,
        &thread.model,
        json!([]),
        false,
        None,
    )
    .await
    .unwrap();
    assert_header(&mut other_received, None).await;
    send(&state, &user, &thread, &other_upstream).await.unwrap();
    assert_header(&mut other_received, None).await;
    server.abort();
    other_server.abort();
}

#[tokio::test]
async fn codex_turn_state_is_saved_before_the_stream_completes() {
    let (_root, state) = test_state();
    enabled(&state, true);
    let user = user_for_subject(&state, "stream-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let (finish, finished) = tokio::sync::oneshot::channel();
    let body = Body::from_stream(async_stream::stream! {
        yield Ok::<_, Infallible>(axum::body::Bytes::from_static(b": waiting\n\n"));
        finished.await.unwrap();
        yield Ok(axum::body::Bytes::from_static(b"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"fixture\",\"output\":[]}}\n\n"));
    });
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(CODEX_TURN_STATE_HEADER, "in-flight-state")
        .body(body)
        .unwrap();
    let (integrations, mut received, server) = upstream(vec![response]).await;
    let request = tokio::spawn({
        let state = state.clone();
        let user = user.clone();
        let thread = thread.clone();
        async move { send(&state, &user, &thread, &integrations).await }
    });
    assert_header(&mut received, None).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let id = thread.id.clone();
            let stored: Option<Vec<u8>> = user_db(&state, &user, false, move |connection| {
                connection
                    .query_row(
                        "SELECT value FROM thread_turn_states WHERE thread_id=?",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(ApiError::from)
            })
            .await
            .unwrap();
            if stored.as_deref() == Some(b"in-flight-state") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("response header must be cached before the response body completes");
    assert!(!request.is_finished());
    finish.send(()).unwrap();
    request.await.unwrap().unwrap();
    server.abort();
}

#[tokio::test]
async fn codex_turn_state_schema_upgrade_preserves_existing_threads_and_history() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "upgrade-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    {
        let connection = open_user(&user.path, false).unwrap();
        super::tests::insert_record(
            &connection,
            &thread.id,
            "input",
            json!({"content":"preserve me"}),
        );
        connection
            .execute_batch("DROP TABLE thread_turn_states; PRAGMA user_version=9;")
            .unwrap();
    }
    let connection = open_user(&user.path, false).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        10
    );
    let history: String = connection
        .query_row(
            "SELECT payload FROM history_records WHERE thread_id=?",
            [&thread.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&history).unwrap(),
        json!({"content":"preserve me"})
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM thread_turn_states", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    check_user_foreign_keys(&connection).unwrap();
}
