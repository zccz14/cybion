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
    let (header, claims) = open(&token, &state.thread_tokens.jwks());

    assert_eq!(header["alg"], "EdDSA");
    assert_eq!(header["typ"], "JWT");
    assert_eq!(claims["iss"], thread_tokens::ISSUER);
    assert_eq!(claims["sub"], thread_id.as_str());
    assert_eq!(claims["exp"], expires_at);
    let ttl = expires_at - claims["iat"].as_i64().unwrap();
    assert_eq!(ttl, 15 * 60, "a token lives exactly fifteen minutes");
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
async fn the_published_key_verifies_only_what_this_installation_signed() {
    let (_root, state) = test_state();
    let (_other_root, other) = test_state();
    let thread_id = Uuid::new_v4().to_string();
    let (token, _) = sign(&state, &thread_id).await;

    let jwks = state.thread_tokens.jwks();
    let key = &jwks["keys"][0];
    assert_eq!(key["kty"], "OKP");
    assert_eq!(key["crv"], "Ed25519");
    assert_eq!(key["alg"], "EdDSA");
    assert_eq!(key["use"], "sig");
    assert!(
        !key["kid"].as_str().unwrap().is_empty(),
        "a verifier selects the key by kid"
    );
    assert_ne!(
        key["x"],
        other.thread_tokens.jwks()["keys"][0]["x"],
        "each installation signs with its own key"
    );
    open(&token, &jwks);
}

#[test]
fn the_key_is_private_to_the_installation_and_survives_a_restart() {
    let root = tempfile::tempdir().unwrap();
    prepare_data_dir(root.path()).unwrap();
    let first = thread_tokens::Issuer::load_or_create(root.path()).unwrap();
    let path = root.path().join("thread-token.key");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "only the Controller reads the signing key");
    }
    let (token, _) = first.issue("6f0a1c22-0000-4000-8000-000000000000");
    // A restart must find the same key, or every verifier would see a token it
    // cannot attribute to a key it already trusts.
    let second = thread_tokens::Issuer::load_or_create(root.path()).unwrap();
    assert_eq!(
        first.jwks()["keys"][0]["kid"],
        second.jwks()["keys"][0]["kid"]
    );
    let (_header, claims) = open(&token, &second.jwks());
    assert!(
        claims["sub"].as_str().unwrap().starts_with("6f0a1c22"),
        "the token signed before the restart is still the same Thread"
    );
}
