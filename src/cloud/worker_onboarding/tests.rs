use super::*;
use crate::cloud::tests::test_state;

fn identity(state: &AppState, name: &str) -> BrowserIdentity {
    BrowserIdentity {
        user: user_for_subject(state, name).unwrap(),
        bearer: String::new(),
    }
}
async fn begin(state: &AppState) -> Value {
    start(
        State(state.clone()),
        Json(StartInput {
            device_secret: "a".repeat(64),
            token_hash: hash_secret("device-token"),
            hostname: "Fixture Mac".into(),
            platform: "macos / aarch64".into(),
            version: "0.1.4".into(),
        }),
    )
    .await
    .unwrap()
    .0
}
fn headers(secret: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {secret}").parse().unwrap(),
    );
    headers
}

#[tokio::test]
async fn pairing_requires_explicit_approval_and_device_proof_and_never_returns_token() {
    let (_root, state) = test_state();
    let started = begin(&state).await;
    let code = started["user_code"].as_str().unwrap().to_owned();
    let id = started["id"].as_str().unwrap().to_owned();
    let owner = identity(&state, "alice");
    let initial = poll(
        State(state.clone()),
        AxumPath(id.clone()),
        headers(&"a".repeat(64)),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(initial["status"], "pending");
    assert!(initial["user_id"].is_null());
    assert!(
        poll(
            State(state.clone()),
            AxumPath(id.clone()),
            headers(&"b".repeat(64))
        )
        .await
        .is_err()
    );
    let approved = approve(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(code.clone()),
        Json(ApproveInput {
            label: "My Mac".into(),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(approved.status, "approved");
    let again = approve(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(code.clone()),
        Json(ApproveInput {
            label: "duplicate".into(),
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(again.worker_id, approved.worker_id);
    assert!(
        read(
            State(state.clone()),
            axum::Extension(identity(&state, "bob")),
            AxumPath(code.clone())
        )
        .await
        .is_err()
    );
    assert!(
        approve(
            State(state.clone()),
            axum::Extension(identity(&state, "bob")),
            AxumPath(code.clone()),
            Json(ApproveInput {
                label: "stolen".into()
            })
        )
        .await
        .is_err()
    );
    let worker = approved.worker_id.clone();
    let id_copy = id.clone();
    pairing_db(&state, move |c| {
        c.execute(
            "UPDATE device_pairings SET last_polled_at=0 WHERE id=?",
            [id_copy],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let reply = poll(State(state.clone()), AxumPath(id), headers(&"a".repeat(64)))
        .await
        .unwrap()
        .0;
    assert_eq!(reply["status"], "approved");
    assert_eq!(reply["user_id"], "alice");
    assert!(!reply.to_string().contains("device-token"));
    assert!(reply.get("access_token").is_none());
    worker_identity(
        &state,
        &headers("device-token"),
        "alice".into(),
        worker.clone(),
    )
    .await
    .unwrap();
    let worker_copy = worker.clone();
    let count = user_db(&state, &owner.user, false, move |c| {
        let count: i64 = c.query_row("SELECT count(*) FROM workers", [], |r| r.get(0))?;
        c.execute("DELETE FROM workers WHERE id=?", [worker_copy])?;
        Ok(count)
    })
    .await
    .unwrap();
    assert_eq!(count, 1);
    let _ = approve(
        State(state.clone()),
        axum::Extension(owner),
        AxumPath(code),
        Json(ApproveInput {
            label: "must not resurrect".into(),
        }),
    )
    .await
    .unwrap();
    assert!(
        worker_identity(&state, &headers("device-token"), "alice".into(), worker)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn expiry_cancel_and_throttling_are_terminal_and_bounded() {
    let (_root, state) = test_state();
    let started = begin(&state).await;
    let code = started["user_code"].as_str().unwrap().to_owned();
    cancel(
        State(state.clone()),
        axum::Extension(identity(&state, "alice")),
        AxumPath(code.clone()),
    )
    .await
    .unwrap();
    assert!(
        approve(
            State(state.clone()),
            axum::Extension(identity(&state, "alice")),
            AxumPath(code),
            Json(ApproveInput {
                label: "bad".into()
            })
        )
        .await
        .is_err()
    );
    let started = begin(&state).await;
    let code = started["user_code"].as_str().unwrap().to_owned();
    pairing_db(&state, |c| {
        c.execute("UPDATE device_pairings SET expires_at=?", [now() - 1])?;
        Ok(())
    })
    .await
    .unwrap();
    let expired = read(
        State(state.clone()),
        axum::Extension(identity(&state, "alice")),
        AxumPath(code.clone()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(expired.status, "expired");
    assert!(
        approve(
            State(state.clone()),
            axum::Extension(identity(&state, "alice")),
            AxumPath(code),
            Json(ApproveInput {
                label: "bad".into()
            })
        )
        .await
        .is_err()
    );
    let err = poll(
        State(state.clone()),
        AxumPath(started["id"].as_str().unwrap().to_owned()),
        headers(&"a".repeat(64)),
    )
    .await
    .unwrap_err();
    assert_eq!(err.status, StatusCode::GONE);
    pairing_db(&state, |c| {
        rate_limit(c, "test", 1)?;
        assert_eq!(
            rate_limit(c, "test", 1).unwrap_err().status,
            StatusCode::TOO_MANY_REQUESTS
        );
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn check_validates_dispatch_and_result_without_creating_a_model_thread() {
    let (_root, state) = test_state();
    let owner = identity(&state, "alice");
    let started = begin(&state).await;
    let paired = approve(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(started["user_code"].as_str().unwrap().into()),
        Json(ApproveInput {
            label: "checked".into(),
        }),
    )
    .await
    .unwrap()
    .0;
    let worker = paired.worker_id;
    assert!(
        check_start(
            State(state.clone()),
            axum::Extension(owner.clone()),
            AxumPath(worker.clone())
        )
        .await
        .is_err()
    );
    let id = worker.clone();
    user_db(&state, &owner.user, false, move |c| {
        c.execute("UPDATE workers SET version='0.1.4' WHERE id=?", [id])?;
        Ok(())
    })
    .await
    .unwrap();
    let check = check_start(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(worker.clone()),
    )
    .await
    .unwrap()
    .0
    .unwrap();
    let repeated = check_start(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(worker.clone()),
    )
    .await
    .unwrap()
    .0
    .unwrap();
    assert_eq!(check.id, repeated.id);
    assert!(
        check_read(
            State(state.clone()),
            axum::Extension(identity(&state, "bob")),
            AxumPath(worker.clone())
        )
        .await
        .is_err()
    );
    let id = worker.clone();
    let call = user_db(&state, &owner.user, false, move |c| {
        claim_worker_call(c, &id)
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(call.name, "diagnostics");
    assert_eq!(call.id, check.id);
    let id = worker.clone();
    assert!(
        user_db(&state, &owner.user, false, move |c| claim_worker_call(
            c, &id
        ))
        .await
        .unwrap()
        .is_none()
    );
    let input = serde_json::from_value(
        json!({"result":{"shell":{"status":"ready","detail":"shell_ok"}},"failed":false}),
    )
    .unwrap();
    let _ = check_result(
        State(state.clone()),
        axum::Extension(owner.user.clone()),
        AxumPath((owner.user.id.clone(), worker.clone(), check.id)),
        Json(input),
    )
    .await
    .unwrap();
    let done = check_read(
        State(state.clone()),
        axum::Extension(owner.clone()),
        AxumPath(worker.clone()),
    )
    .await
    .unwrap()
    .0
    .unwrap();
    assert_eq!(done.status, "completed");
    user_db(&state, &owner.user, false, move |c| {
        let count: i64 = c.query_row("SELECT count(*) FROM threads", [], |r| r.get(0))?;
        assert_eq!(count, 0);
        c.execute(
            "UPDATE worker_checks SET completed_at=NULL,created_at=?",
            [now() - 31],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(
        check_read(
            State(state.clone()),
            axum::Extension(owner),
            AxumPath(worker)
        )
        .await
        .unwrap()
        .0
        .unwrap()
        .status,
        "timed_out"
    );
}

#[tokio::test]
async fn http_pairing_rejects_unauthenticated_approval_and_keeps_secrets_out_of_public_metadata() {
    let (_root, state) = test_state();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::new();
    let reply:Value=client.post(format!("{base}/worker/v1/pairings")).json(&json!({"device_secret":"a".repeat(64),"token_hash":hash_secret("secret"),"hostname":"HTTP device","platform":"linux","version":"0.1.4"})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    assert!(reply.get("device_secret").is_none());
    assert!(reply.get("token_hash").is_none());
    let code = reply["user_code"].as_str().unwrap();
    for method in [
        reqwest::Method::GET,
        reqwest::Method::POST,
        reqwest::Method::DELETE,
    ] {
        assert_eq!(
            client
                .request(method, format!("{base}/api/worker-pairings/{code}"))
                .json(&json!({"label":"no"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        client
            .get(format!(
                "{base}/worker/v1/pairings/{}",
                reply["id"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let release: Value = client
        .get(format!("{base}/api/worker-release"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(release["platforms"].as_array().unwrap().len(), 5);
    server.abort();
}

#[test]
fn code_and_version_validation() {
    assert_eq!(code(" abcd 1234-ef56 ").unwrap(), "ABCD-1234-EF56");
    assert!(code("../../secret").is_err());
    assert!(hex_secret("abcd").is_err());
    assert!(!supports_checks("0.1.3"));
    assert!(supports_checks("0.1.4"));
    assert!(supports_checks("0.2.0"));
    assert!(!supports_checks("garbage"));
    let release: Value =
        serde_json::from_str(include_str!("../../../worker-release.json")).unwrap();
    assert_eq!(release["version"], "v0.1.4");
}

async fn authenticated_fixture(state: &AppState) -> (String, tokio::task::JoinHandle<()>) {
    use crate::cloud::settings_tests::base64url;
    use ed25519_dalek::{Signer, SigningKey};
    let key = SigningKey::from_bytes(&[47; 32]);
    let jwks = json!({"keys":[{"kid":"test","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":base64url(&key.verifying_key().to_bytes())}]});
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/jwks", get(move || async { Json(jwks) })),
        )
        .await
        .unwrap()
    });
    let auth = AuthMiniLayer::from_issuer(&issuer, AUTH_AUDIENCE, JwksCachePolicy::default())
        .await
        .unwrap();
    assert!(state.auth.set(auth).is_ok());
    let claims = json!({"sub":"onboarding-http-owner","sid":"fixture","iss":issuer,"aud":AUTH_AUDIENCE,"amr":["webauthn"],"typ":"access","iat":now(),"exp":now()+60});
    let signed = format!(
        "{}.{}",
        base64url(br#"{"alg":"EdDSA","kid":"test"}"#),
        base64url(claims.to_string().as_bytes())
    );
    (
        format!(
            "{signed}.{}",
            base64url(&key.sign(signed.as_bytes()).to_bytes())
        ),
        task,
    )
}

#[tokio::test]
async fn authenticated_http_flow_checks_the_real_event_and_result_routes() {
    let (_root, state) = test_state();
    let (token, issuer) = authenticated_fixture(&state).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    let client = reqwest::Client::new();
    let pairing:Value=client.post(format!("{base}/worker/v1/pairings")).json(&json!({"device_secret":"a".repeat(64),"token_hash":hash_secret("http-worker-token"),"hostname":"HTTP worker","platform":"linux","version":"0.1.4"})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let approved: PairingView = client
        .post(format!(
            "{base}/api/worker-pairings/{}",
            pairing["user_code"].as_str().unwrap()
        ))
        .bearer_auth(&token)
        .json(&json!({"label":"HTTP test"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let polled: Value = client
        .get(format!(
            "{base}/worker/v1/pairings/{}",
            pairing["id"].as_str().unwrap()
        ))
        .bearer_auth("a".repeat(64))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(polled["status"], "approved");
    let worker_base = format!(
        "{base}/worker/v1/users/onboarding-http-owner/workers/{}",
        approved.worker_id
    );
    client
        .post(format!("{worker_base}/heartbeat"))
        .bearer_auth("http-worker-token")
        .json(&json!({"version":"0.1.4","hostname":"HTTP worker"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let check: CheckView = client
        .post(format!("{base}/api/workers/{}/check", approved.worker_id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut events = client
        .get(format!("{worker_base}/events"))
        .bearer_auth("http-worker-token")
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(5), events.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let frame = String::from_utf8(frame.to_vec()).unwrap();
    assert!(frame.contains("diagnostics"));
    assert!(frame.contains(&check.id));
    drop(events);
    client
        .post(format!("{worker_base}/checks/{}/result", check.id))
        .bearer_auth("http-worker-token")
        .json(&json!({"result":{"shell":{"status":"ready","detail":"shell_ok"}},"failed":false}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let done: CheckView = client
        .get(format!("{base}/api/workers/{}/check", approved.worker_id))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(done.status, "completed");
    assert_eq!(
        client
            .get(format!("{base}/api/workers/{}/check", approved.worker_id))
            .bearer_auth("http-worker-token")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    server.abort();
    issuer.abort();
}

#[tokio::test]
async fn simultaneous_approvals_have_one_owner_and_expiring_codes_get_a_claim_window() {
    let (_root, state) = test_state();
    let started = begin(&state).await;
    let code = started["user_code"].as_str().unwrap().to_owned();
    pairing_db(&state, |c| {
        c.execute("UPDATE device_pairings SET expires_at=?", [now() + 2])?;
        Ok(())
    })
    .await
    .unwrap();
    let (first, second) = tokio::join!(
        approve(
            State(state.clone()),
            axum::Extension(identity(&state, "alice")),
            AxumPath(code.clone()),
            Json(ApproveInput {
                label: "Alice device".into()
            })
        ),
        approve(
            State(state.clone()),
            axum::Extension(identity(&state, "bob")),
            AxumPath(code),
            Json(ApproveInput {
                label: "Bob device".into()
            })
        )
    );
    assert_ne!(first.is_ok(), second.is_ok());
    let winner = first.or(second).unwrap().0;
    assert!(winner.expires_at >= now() + 590);
}

// Local-only integration fixture for testing a real Worker binary against the
// real controller routes. Compiled exclusively into the test executable.
#[tokio::test]
#[ignore]
async fn real_worker_fixture() {
    let root = std::env::var("CYBION_ONBOARDING_FIXTURE_DIR").unwrap();
    let (_state_root, state) = test_state();
    let (token, _issuer) = authenticated_fixture(&state).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://localhost:{}", listener.local_addr().unwrap().port());
    let path = PathBuf::from(root).join("fixture.json");
    let content = json!({"base":base,"token":token}).to_string();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(path)
        .unwrap()
        .write_all(content.as_bytes())
        .unwrap();
    axum::serve(listener, app(state)).await.unwrap();
}
