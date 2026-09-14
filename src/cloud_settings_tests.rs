use super::tests::test_state;
use super::*;
use ed25519_dalek::{Signer, SigningKey};

fn base64url(bytes: &[u8]) -> String {
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

#[tokio::test]
async fn authenticated_http_settings_round_trip_drives_thread_creation() {
    let (_root, state) = test_state();
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
    let claims = json!({
        "sub":"http-settings-owner","sid":"test-session","iss":issuer,"aud":AUTH_AUDIENCE,
        "amr":["webauthn"],"typ":"access","iat":now(),"exp":now()+60,
    });
    let signing_input = format!(
        "{}.{}",
        base64url(br#"{"alg":"EdDSA","kid":"test"}"#),
        base64url(claims.to_string().as_bytes())
    );
    let token = format!(
        "{signing_input}.{}",
        base64url(&key.sign(signing_input.as_bytes()).to_bytes())
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
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
    server.abort();
    issuer_task.abort();
}

fn browser_identity_for(user: &User) -> axum::Extension<BrowserIdentity> {
    axum::Extension(BrowserIdentity {
        user: user.clone(),
        bearer: String::new(),
    })
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
        ("bad/model", "high"),
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
    ] {
        assert!(serde_json::from_value::<ThreadDefaults>(input).is_err());
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
    assert!(connection.execute("INSERT INTO history_records(thread_id,role,content,created_at) VALUES('missing-thread','user','bad',1)", []).is_err());
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
