use super::tests::test_state;
use super::*;
use ed25519_dalek::{Signer, SigningKey};

pub(super) fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::new();
    let mut buffer = 0_u32;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            encoded.push(ALPHABET[((buffer >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        encoded.push(ALPHABET[((buffer << (6 - bits)) & 63) as usize] as char);
    }
    encoded
}

#[test]
fn existing_user_request_headers_migrate_to_global_admin_settings() {
    let root = tempfile::tempdir().unwrap();
    prepare_data_dir(root.path()).unwrap();
    let admin_db = root.path().join("default.sqlite3");
    prepare_admin_db(&admin_db).unwrap();
    let user_db = root.path().join("users/root.sqlite3");
    let connection = Connection::open(&user_db).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE integration_settings (
                id INTEGER PRIMARY KEY,
                openai_consumer_id TEXT NOT NULL,
                openai_consumer_secret TEXT NOT NULL,
                openai_base_url TEXT NOT NULL,
                user_agent TEXT NOT NULL,
                originator TEXT NOT NULL,
                linkit_bot_id TEXT NOT NULL,
                linkit_bot_token TEXT NOT NULL,
                linkit_username TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO integration_settings VALUES(1,'','','','Migrated-UA/1.0','migrated-client','','','',1);",
        )
        .unwrap();
    connection.close().unwrap();
    set_admin_meta_string_sync(&admin_db, "root_user_id", "root").unwrap();
    migrate_global_request_headers(&admin_db, root.path()).unwrap();
    assert_eq!(
        admin_meta_string_sync(&admin_db, GLOBAL_USER_AGENT_KEY)
            .unwrap()
            .as_deref(),
        Some("Migrated-UA/1.0")
    );
    assert_eq!(
        admin_meta_string_sync(&admin_db, GLOBAL_ORIGINATOR_KEY)
            .unwrap()
            .as_deref(),
        Some("migrated-client")
    );
    assert_eq!(
        admin_meta_string_sync(&admin_db, GLOBAL_REQUEST_HEADERS_MIGRATED_KEY)
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

async fn install_test_issuer(
    state: &AppState,
) -> (String, SigningKey, tokio::task::JoinHandle<()>) {
    let key = SigningKey::from_bytes(&[42; 32]);
    let jwks = json!({"keys":[{
        "kid":"test","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig",
        "x":base64url(&key.verifying_key().to_bytes()),
    }]});
    let issuer_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", issuer_listener.local_addr().unwrap());
    let issuer_task = tokio::spawn(async move {
        axum::serve(
            issuer_listener,
            Router::new().route("/jwks", get(move || async { Json(jwks) })),
        )
        .await
        .unwrap();
    });
    let layer = AuthMiniLayer::from_issuer(&issuer, AUTH_AUDIENCE, JwksCachePolicy::default())
        .await
        .unwrap();
    assert!(state.auth.set(layer).is_ok());
    (issuer, key, issuer_task)
}

fn browser_token(issuer: &str, key: &SigningKey, subject: &str, session: &str) -> String {
    let claims = json!({
        "sub":subject,"sid":session,"iss":issuer,"aud":AUTH_AUDIENCE,
        "amr":["webauthn"],"typ":"access","iat":now(),"exp":now()+60,
    });
    let signing_input = format!(
        "{}.{}",
        base64url(br#"{"alg":"EdDSA","kid":"test"}"#),
        base64url(claims.to_string().as_bytes())
    );
    format!(
        "{signing_input}.{}",
        base64url(&key.sign(signing_input.as_bytes()).to_bytes())
    )
}

#[tokio::test]
async fn authenticated_http_settings_round_trip_drives_thread_creation() {
    let (_root, state) = test_state();
    let (issuer, key, issuer_task) = install_test_issuer(&state).await;
    let token = browser_token(&issuer, &key, "http-settings-owner", "test-session");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    assert!(admin_user_sync(&state.admin_db_path, "http-settings-owner", true).unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::new();
    let settings_url = format!("{base}/api/thread-defaults");
    let defaults = json!({"model":"gpt-6-astra","reasoning_effort":"max","service_tier_fast":true});
    for method in [reqwest::Method::GET, reqwest::Method::PUT] {
        assert_eq!(
            client
                .request(method, &settings_url)
                .json(&defaults)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let saved: Value = client
        .put(&settings_url)
        .bearer_auth(&token)
        .json(&defaults)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved, defaults);
    let loaded: Value = client
        .get(&settings_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(loaded, defaults);
    let integrations_url = format!("{base}/api/integrations");
    let integrations: Value = client
        .get(&integrations_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(integrations["user_agent"], "");
    assert_eq!(integrations["originator"], "");
    let custom_headers = json!({"user_agent":"My-Cybion/1.0","originator":"my-client"});
    let saved_integrations: Value = client
        .put(&integrations_url)
        .bearer_auth(&token)
        .json(&custom_headers)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        saved_integrations["user_agent"],
        custom_headers["user_agent"]
    );
    assert_eq!(
        saved_integrations["originator"],
        custom_headers["originator"]
    );
    assert_eq!(
        client
            .put(&integrations_url)
            .bearer_auth(&token)
            .json(&json!({"user_agent":"bad\nvalue"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(&settings_url)
            .bearer_auth(&token)
            .json(&json!({"model":"gpt-6-astra"}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let created: Value = client
        .post(format!("{base}/api/threads"))
        .bearer_auth(&token)
        .json(&json!({"title":"HTTP smoke"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    for field in ["model", "reasoning_effort", "service_tier_fast"] {
        assert_eq!(created[field], defaults[field]);
    }
    let thread_url = format!("{base}/api/threads/{}", created["id"].as_str().unwrap());
    let patched: Value = client
        .patch(&thread_url)
        .bearer_auth(&token)
        .json(&json!({"service_tier_fast":false}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(patched["service_tier_fast"], false);
    assert_eq!(
        client
            .patch(&thread_url)
            .bearer_auth(&token)
            .json(&json!({"web_search":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        client
            .patch(&thread_url)
            .bearer_auth(&token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let experiments_url = format!("{base}/api/experimental-features");
    let initial: Value = client
        .get(&experiments_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        initial,
        json!({"thread_id_header":false,"session_id_header":false,"codex_turn_state_header":false})
    );
    for (update, expected) in [
        (
            json!({"codex_turn_state_header":true}),
            json!({"thread_id_header":false,"session_id_header":false,"codex_turn_state_header":true}),
        ),
        (
            json!({"session_id_header":true}),
            json!({"thread_id_header":false,"session_id_header":true,"codex_turn_state_header":true}),
        ),
        (
            json!({"thread_id_header":true}),
            json!({"thread_id_header":true,"session_id_header":true,"codex_turn_state_header":true}),
        ),
        (
            json!({"codex_turn_state_header":false}),
            json!({"thread_id_header":true,"session_id_header":true,"codex_turn_state_header":false}),
        ),
        (
            json!({"session_id_header":false}),
            json!({"thread_id_header":true,"session_id_header":false,"codex_turn_state_header":false}),
        ),
    ] {
        let saved: Value = client
            .put(&experiments_url)
            .bearer_auth(&token)
            .json(&update)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(saved, expected);
        let loaded: Value = client
            .get(&experiments_url)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(loaded, expected);
    }
    assert_eq!(
        client
            .put(&experiments_url)
            .json(&json!({"session_id_header":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let other_token = browser_token(&issuer, &key, "http-settings-other", "other-session");
    for (url, body) in [
        (
            &integrations_url,
            json!({"user_agent":"not-allowed","originator":"not-allowed"}),
        ),
        (
            &experiments_url,
            json!({"thread_id_header":false,"session_id_header":true,"codex_turn_state_header":true}),
        ),
    ] {
        for method in [reqwest::Method::GET, reqwest::Method::PUT] {
            assert_eq!(
                client
                    .request(method, url)
                    .json(&body)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            client
                .put(url)
                .bearer_auth(&other_token)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    let unchanged_headers: Value = client
        .get(&integrations_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    for field in ["user_agent", "originator"] {
        assert_eq!(unchanged_headers[field], custom_headers[field]);
    }
    let unchanged_features: Value = client
        .get(&experiments_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        unchanged_features,
        json!({"thread_id_header":true,"session_id_header":false,"codex_turn_state_header":false})
    );
    assert_eq!(
        client
            .put(&settings_url)
            .bearer_auth(&other_token)
            .json(&defaults)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    server.abort();
    issuer_task.abort();
}

fn browser_identity_for(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
}

async fn read_request_head(stream: &mut tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert_ne!(read, 0);
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            return String::from_utf8(bytes).unwrap();
        }
    }
}

async fn serve_model_catalog_once() -> (u16, tokio::task::JoinHandle<String>) {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let head = read_request_head(&mut socket).await;
        let body = json!({"object":"list","data":[{"id":"gpt-5.6-terra"},{"id":"meta-llama/Llama-3.1-8B-Instruct"}]}).to_string();
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
        head
    });
    (port, task)
}

#[tokio::test]
async fn authenticated_http_models_route_serves_the_endpoint_catalog() {
    let (_root, state) = test_state();
    let (issuer, key, issuer_task) = install_test_issuer(&state).await;
    let token = browser_token(&issuer, &key, "http-models-owner", "models-session");
    let (catalog_port, catalog) = serve_model_catalog_once().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::new();
    let _ = client
        .put(format!("{base}/api/integrations/openai"))
        .bearer_auth(&token)
        .json(&json!({
            "base_url": format!("http://127.0.0.1:{catalog_port}/v1"),
            "api_key": "sk-http-models",
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let models: Value = client
        .get(format!("{base}/api/integrations/openai/models"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        models,
        json!({"models":["gpt-5.6-terra","meta-llama/Llama-3.1-8B-Instruct"]})
    );
    assert_eq!(
        client
            .get(format!("{base}/api/integrations/openai/models"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    catalog.await.unwrap();
    server.abort();
    issuer_task.abort();
}

#[tokio::test]
async fn available_models_come_from_the_configured_endpoint_catalog() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "models-owner").unwrap();
    let unconfigured = openai_models(State(state.clone()), browser_identity_for(&user))
        .await
        .unwrap_err();
    assert_eq!(unconfigured.status, StatusCode::CONFLICT);

    let (catalog_port, catalog) = serve_model_catalog_once().await;
    let _ = update_openai_api_config(
        State(state.clone()),
        browser_identity_for(&user),
        Json(UpdateOpenAiApiConfigInput {
            base_url: format!("http://127.0.0.1:{catalog_port}/v1"),
            api_key: Some("sk-custom".to_owned()),
        }),
    )
    .await
    .unwrap();
    let models = openai_models(State(state.clone()), browser_identity_for(&user))
        .await
        .unwrap()
        .0;
    assert_eq!(
        models.models,
        ["gpt-5.6-terra", "meta-llama/Llama-3.1-8B-Instruct"]
    );
    let head = catalog.await.unwrap().to_lowercase();
    assert!(head.starts_with("get /v1/models http/1.1"));
    assert!(head.contains("authorization: bearer sk-custom"));
    assert!(head.contains("session-id: "));

    let defaults = ThreadDefaults {
        model: "meta-llama/Llama-3.1-8B-Instruct".to_owned(),
        reasoning_effort: "high".to_owned(),
        service_tier_fast: false,
    };
    assert_eq!(
        update_thread_defaults(
            State(state),
            browser_identity_for(&user),
            Json(defaults.clone())
        )
        .await
        .unwrap()
        .0,
        defaults
    );
}

#[tokio::test]
async fn user_openai_api_configuration_round_trips_without_exposing_the_key() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "api-config-owner").unwrap();
    let initial = openai_api_config(State(state.clone()), browser_identity_for(&user))
        .await
        .unwrap()
        .0;
    assert_eq!(initial.base_url, OPENAI_BASE_URL);
    assert!(!initial.api_key_configured);

    let saved = update_openai_api_config(
        State(state.clone()),
        browser_identity_for(&user),
        Json(UpdateOpenAiApiConfigInput {
            base_url: "http://127.0.0.1:4242/v1/".to_owned(),
            api_key: Some("sk-user-configured".to_owned()),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(saved.base_url, "http://127.0.0.1:4242/v1");
    assert!(saved.api_key_configured);
    let stored = user_db(&state, &user, false, |connection| {
        integration_settings(connection)
    })
    .await
    .unwrap();
    assert!(stored.openai_consumer_id.is_empty());
    assert!(stored.openai_consumer_secret.is_empty());
    assert_eq!(stored.api_key, "sk-user-configured");

    let invalid = update_openai_api_config(
        State(state),
        browser_identity_for(&user),
        Json(UpdateOpenAiApiConfigInput {
            base_url: "ftp://provider.example/v1".to_owned(),
            api_key: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn experimental_features_can_only_be_changed_by_the_administrator() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let user = user_for_subject(&state, "other-user").unwrap();
    for feature in [
        "thread_id_header",
        "session_id_header",
        "codex_turn_state_header",
    ] {
        let error = update_experimental_features(
            State(state.clone()),
            browser_identity_for(&user),
            Json(serde_json::from_value(json!({feature:true})).unwrap()),
        )
        .await
        .err()
        .expect("non-administrator must be rejected");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }
    let features = experimental_features(State(state)).await.unwrap().0;
    assert!(!features.thread_id_header);
    assert!(!features.session_id_header);
    assert!(!features.codex_turn_state_header);
}

#[tokio::test]
async fn global_request_headers_can_only_be_changed_by_the_administrator() {
    let (_root, state) = test_state();
    assert!(admin_user_sync(&state.admin_db_path, "root", true).unwrap());
    let user = user_for_subject(&state, "other-user").unwrap();
    let error = update_integrations(
        State(state),
        browser_identity_for(&user),
        Json(UpdateIntegrationHeadersInput {
            user_agent: Some("not-allowed".to_owned()),
            originator: Some("not-allowed".to_owned()),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn thread_defaults_persist_per_user_and_only_apply_to_new_threads() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "defaults-owner").unwrap();
    let other = user_for_subject(&state, "other-owner").unwrap();
    let initial = read_thread_defaults(State(state.clone()), browser_identity_for(&user))
        .await
        .unwrap()
        .0;
    assert_eq!(initial, ThreadDefaults::default());
    let old_thread = create_thread(
        State(state.clone()),
        browser_identity_for(&user),
        Json(serde_json::from_value(json!({})).unwrap()),
    )
    .await
    .unwrap()
    .0;
    let defaults = ThreadDefaults {
        model: "gpt-6-astra".to_owned(),
        reasoning_effort: "max".to_owned(),
        service_tier_fast: true,
    };
    let saved = update_thread_defaults(
        State(state.clone()),
        browser_identity_for(&user),
        Json(defaults.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(saved, defaults);
    assert_eq!(
        read_thread_defaults(State(state.clone()), browser_identity_for(&user))
            .await
            .unwrap()
            .0,
        defaults
    );
    assert_eq!(
        read_thread_defaults(State(state.clone()), browser_identity_for(&other))
            .await
            .unwrap()
            .0,
        initial
    );
    let new_thread = create_thread(
        State(state.clone()),
        browser_identity_for(&user),
        Json(serde_json::from_value(json!({"title":"Browser defaults"})).unwrap()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(new_thread.model, defaults.model);
    assert_eq!(new_thread.reasoning_effort, defaults.reasoning_effort);
    assert!(new_thread.service_tier_fast);
    for model in [None, Some("gpt-5.6-sol")] {
        let thread = external_create_thread(
            State(state.clone()),
            axum::Extension(ApiIdentity { user: user.clone() }),
            Json(CreateThreadInput {
                title: None,
                model: model.map(str::to_owned),
                reasoning_effort: None,
                service_tier_fast: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(thread.model, model.unwrap_or(&defaults.model));
        assert_eq!(thread.reasoning_effort, "max");
        assert!(thread.service_tier_fast);
    }
    let old_thread = read_thread_for(&state, &user, old_thread.id).await.unwrap();
    assert_eq!(old_thread.model, initial.model);
    assert_eq!(old_thread.reasoning_effort, initial.reasoning_effort);
    assert!(!old_thread.service_tier_fast);

    let _ = update_thread_defaults(
        State(state.clone()),
        browser_identity_for(&user),
        Json(initial.clone()),
    )
    .await
    .unwrap();
    let next = create_thread_for(&state, &user, serde_json::from_value(json!({})).unwrap())
        .await
        .unwrap();
    assert_eq!(next.model, initial.model);
    assert_eq!(next.reasoning_effort, initial.reasoning_effort);
    assert!(!next.service_tier_fast);
    let existing = read_thread_for(&state, &user, new_thread.id).await.unwrap();
    assert_eq!(existing.model, defaults.model);
    assert!(existing.service_tier_fast);
    let connection = open_user(&user.path, false).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM thread_defaults", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn thread_defaults_reject_invalid_values_without_overwriting_saved_settings() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "validation-owner").unwrap();
    let saved = ThreadDefaults {
        model: "gpt-6-astra".to_owned(),
        reasoning_effort: "high".to_owned(),
        service_tier_fast: true,
    };
    let _ = update_thread_defaults(
        State(state.clone()),
        browser_identity_for(&user),
        Json(saved.clone()),
    )
    .await
    .unwrap();
    for (model, effort) in [
        ("", "high"),
        ("bad model", "high"),
        ("gpt-6-astra", "invalid"),
    ] {
        let error = update_thread_defaults(
            State(state.clone()),
            browser_identity_for(&user),
            Json(ThreadDefaults {
                model: model.to_owned(),
                reasoning_effort: effort.to_owned(),
                service_tier_fast: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        read_thread_defaults(State(state), browser_identity_for(&user))
            .await
            .unwrap()
            .0,
        saved
    );
    for input in [
        json!({"model":"gpt-6-astra"}),
        json!({"model":"gpt-6-astra","reasoning_effort":"high","service_tier_fast":"false"}),
        json!({"model":"gpt-6-astra","reasoning_effort":"high","service_tier_fast":false,"user_id":"another-user"}),
        json!({"model":"gpt-6-astra","reasoning_effort":"high","service_tier_fast":false,"web_search":true}),
    ] {
        assert!(serde_json::from_value::<ThreadDefaults>(input).is_err());
    }
}

#[test]
fn legacy_thread_schema_upgrade_keeps_threads_and_defaults() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("existing.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE threads (
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
             PRAGMA user_version=13;
             INSERT INTO threads VALUES('existing-thread','Keep me','gpt-6-astra','high',1,'idle',1,2);
             INSERT INTO thread_defaults VALUES(1,'gpt-6-astra','max',1);",
        )
        .unwrap();
    connection.execute_batch(USER_SCHEMA).unwrap();
    drop(connection);

    for _ in 0..2 {
        let connection = open_user(&path, false).unwrap();
        let thread = load_thread(&connection, "existing-thread").unwrap();
        assert_eq!(thread.title, "Keep me");
        assert_eq!(thread.reasoning_effort, "high");
        assert!(thread.service_tier_fast);
        assert_eq!(
            load_thread_defaults(&connection).unwrap(),
            ThreadDefaults {
                model: "gpt-6-astra".to_owned(),
                reasoning_effort: "max".to_owned(),
                service_tier_fast: true,
            }
        );
    }
}

#[test]
fn max_reasoning_upgrade_preserves_existing_history_and_foreign_keys() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("existing.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(
        "CREATE TABLE threads (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
            reasoning_effort TEXT NOT NULL DEFAULT 'medium' CHECK(reasoning_effort IN ('none','low','medium','high','xhigh')),
            service_tier_fast INTEGER NOT NULL DEFAULT 0 CHECK(service_tier_fast IN (0,1)),
            status TEXT NOT NULL CHECK(status IN ('idle','running','failed')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
         );
         PRAGMA user_version=7;",
    ).unwrap();
    connection
        .execute_batch(schema_tests::LEGACY_HISTORY_SCHEMA)
        .unwrap();
    connection.execute_batch(USER_SCHEMA).unwrap();
    connection.execute_batch(
        "DROP TABLE thread_defaults;
         INSERT INTO threads VALUES('existing-thread','Keep me','gpt-6-astra','high',1,'running',1,2);
         INSERT INTO history_records(id,thread_id,role,content,kind,payload,created_at) VALUES(11,'existing-thread','user','Keep my history','input','{\"role\":\"user\",\"content\":\"Keep my history\"}',1);
         INSERT INTO workers(id,label,token_hash,created_at) VALUES('worker-1','Worker','worker-hash',1);
         INSERT INTO api_keys(id,label,prefix,secret_hash,created_at) VALUES('key-1','Key','prefix','key-hash',1);
         INSERT INTO worker_calls(id,worker_id,thread_id,input_record_id,name,arguments_json,status,created_at) VALUES('call-1','worker-1','existing-thread',11,'bash','{}','queued',1);
         INSERT INTO reasoning_audits(id,input_record_id,thread_id,model,status,started_at) VALUES(21,11,'existing-thread','gpt-6-astra','in_flight',1);
         INSERT INTO response_states(audit_id,snapshot) VALUES(21,'{}');",
    ).unwrap();
    drop(connection);

    for _ in 0..2 {
        let connection = open_user(&path, false).unwrap();
        let thread = load_thread(&connection, "existing-thread").unwrap();
        assert_eq!(thread.title, "Keep me");
        assert_eq!(thread.status, "running");
        assert_eq!(thread.reasoning_effort, "high");
        assert!(thread.service_tier_fast);
        for table in [
            "threads",
            "history_records",
            "workers",
            "api_keys",
            "worker_calls",
            "reasoning_audits",
            "response_states",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 1, "lost rows in {table}");
        }
        let payload: String = connection
            .query_row(
                "SELECT payload FROM history_records WHERE id=11",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payload, r#"{"role":"user","content":"Keep my history"}"#);
        assert_eq!(
            load_thread_defaults(&connection).unwrap(),
            ThreadDefaults::default()
        );
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    let connection = open_user(&path, false).unwrap();
    for effort in ["none", "low", "medium", "high", "xhigh", "max"] {
        connection
            .execute(
                "UPDATE threads SET reasoning_effort=? WHERE id='existing-thread'",
                [effort],
            )
            .unwrap();
        assert_eq!(
            load_thread(&connection, "existing-thread")
                .unwrap()
                .reasoning_effort,
            effort
        );
    }
    assert!(connection.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('missing-thread','input','{}',1)", []).is_err());
    connection
        .execute("DELETE FROM threads WHERE id='existing-thread'", [])
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM history_records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM response_states", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
