use super::tests::test_state;
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// Checks a token the way a verifier must: pick the key by `kid` out of the
/// published document, check the signature over `header.payload`, and only then
/// believe the claims.
fn open(token: &str, jwks: &Value) -> (Value, Value) {
    let mut segments = token.split('.');
    let header_segment = segments.next().expect("header");
    let payload_segment = segments.next().expect("payload");
    let signature_segment = segments.next().expect("signature");
    assert!(
        segments.next().is_none(),
        "a JWT has exactly three segments"
    );
    let header: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header_segment).unwrap()).unwrap();
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload_segment).unwrap()).unwrap();
    let key = jwks["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["kid"] == header["kid"])
        .expect("the JWKS publishes the kid the token names");
    let public: [u8; 32] = URL_SAFE_NO_PAD
        .decode(key["x"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let signature =
        Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature_segment).unwrap()).unwrap();
    VerifyingKey::from_bytes(&public)
        .unwrap()
        .verify(
            format!("{header_segment}.{payload_segment}").as_bytes(),
            &signature,
        )
        .expect("the signature verifies against the published key");
    (header, claims)
}

fn published_keys(jwks: &Value) -> Vec<String> {
    jwks["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key["kid"].as_str().unwrap().to_owned())
        .collect()
}

async fn jwks(state: &AppState) -> Value {
    state.thread_tokens.lock().await.jwks()
}

async fn sign(state: &AppState, thread_id: &str) -> (String, i64) {
    let user = user_for_subject(state, "thread-token-user").unwrap();
    let output = controller_tool_output(state, &user, thread_id, "create_thread_token", "{}")
        .await
        .expect("create_thread_token is a Controller tool")
        .expect("signing does not fail");
    (
        output["token"].as_str().unwrap().to_owned(),
        output["expires_at"].as_i64().unwrap(),
    )
}

#[tokio::test]
async fn the_token_names_the_thread_that_called_the_tool() {
    let (_root, state) = test_state();
    let thread_id = Uuid::new_v4().to_string();
    let (token, expires_at) = sign(&state, &thread_id).await;
    let keys = jwks(&state).await;
    let (header, claims) = open(&token, &keys);

    assert_eq!(header["alg"], "EdDSA");
    assert_eq!(header["typ"], "JWT");
    assert_eq!(
        header["kid"], keys["keys"][0]["kid"],
        "the current key signs, and it is published first"
    );
    assert_eq!(claims["iss"], thread_tokens::ISSUER);
    assert_eq!(claims["sub"], thread_id.as_str());
    assert_eq!(claims["exp"], expires_at);
    let ttl = expires_at - claims["iat"].as_i64().unwrap();
    assert_eq!(ttl, 60, "a token lives exactly one minute");
    assert!(
        (claims["iat"].as_i64().unwrap() - now()).abs() < 5,
        "iat is the moment of signing"
    );
}

#[tokio::test]
async fn the_subject_cannot_be_chosen_by_the_model() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "thread-token-user").unwrap();
    let error = controller_tool_output(
        &state,
        &user,
        "5b2e4f9a-0000-4000-8000-000000000000",
        "create_thread_token",
        r#"{"thread_id":"3f1c2b4d-0000-4000-8000-000000000000"}"#,
    )
    .await
    .expect("create_thread_token is a Controller tool")
    .expect_err("no argument can name another Thread");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_published_document_carries_the_current_and_the_standby_key() {
    let (_root, state) = test_state();
    let (_other_root, other) = test_state();
    let keys = jwks(&state).await;

    assert_eq!(keys["keys"].as_array().unwrap().len(), 2);
    for key in keys["keys"].as_array().unwrap() {
        assert_eq!(key["kty"], "OKP");
        assert_eq!(key["crv"], "Ed25519");
        assert_eq!(key["alg"], "EdDSA");
        assert_eq!(key["use"], "sig");
        assert!(
            !key["kid"].as_str().unwrap().is_empty(),
            "a verifier selects by kid"
        );
    }
    let ours = published_keys(&keys);
    assert_ne!(ours[0], ours[1], "the two slots hold different keys");
    for kid in &ours {
        assert!(
            !published_keys(&jwks(&other).await).contains(kid),
            "each installation signs with its own keys"
        );
    }
}

#[tokio::test]
async fn the_keys_live_in_the_operator_database_and_survive_a_restart() {
    let (root, state) = test_state();
    let before = published_keys(&jwks(&state).await);
    // A restart must find the same pair, or every verifier would see a token it
    // cannot attribute to a key it already trusts.
    let reloaded = thread_tokens::Issuer::load_or_create(state.admin_db_path.as_path()).unwrap();
    assert_eq!(published_keys(&reloaded.jwks()), before);
    assert_eq!(
        before.len(),
        2,
        "the operator database holds exactly a current and a standby"
    );
    assert!(
        !root.path().join("thread-token.key").exists(),
        "the key no longer lives in a file of its own"
    );
}

#[test]
fn rotating_promotes_the_standby_every_verifier_already_has() {
    let root = tempfile::tempdir().unwrap();
    let admin = root.path().join("default.sqlite3");
    prepare_admin_db(&admin).unwrap();
    let before = thread_tokens::Issuer::load_or_create(&admin).unwrap();
    let published_before = before.jwks();
    let standby_kid = published_before["keys"][1]["kid"]
        .as_str()
        .unwrap()
        .to_owned();

    let rotated = thread_tokens::Issuer::rotate(&admin).unwrap();
    let published_after = rotated.jwks();
    assert_eq!(
        published_after["keys"][0]["kid"], standby_kid,
        "the standby becomes the signer"
    );
    assert_ne!(
        published_after["keys"][1]["kid"], standby_kid,
        "a fresh standby is published alongside it"
    );

    // The point of the standby: a verifier holding the *old* document can already
    // verify the token the new signer mints, so a rollover invalidates nothing.
    let (token, _) = rotated.issue("8d1f0a42-0000-4000-8000-000000000000");
    let (header, _) = open(&token, &published_before);
    assert_eq!(header["kid"], standby_kid);

    // The key that signed until now is gone, which is the deliberate cost.
    assert!(
        !published_keys(&published_after).contains(&published_keys(&published_before)[0]),
        "the retired key leaves the document"
    );
    // And the rotation is durable: a restart reads what rotation left behind.
    let reloaded = thread_tokens::Issuer::load_or_create(&admin).unwrap();
    assert_eq!(
        published_keys(&reloaded.jwks()),
        published_keys(&published_after)
    );
}
