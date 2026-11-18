//! A console API key now reaches every route the web console reaches. Only the
//! routes that manage keys themselves stay closed to keys, because a key that
//! could mint another key would outlive its own revocation.

use super::*;
use crate::cloud::tests::{insert_upstream, test_state};

use axum::Router;
use axum::routing::get;
use serde_json::json;

async fn key_secret(state: &AppState, user: &User) -> (String, String) {
    let upstream = insert_upstream(state, user, "fixture", "http://127.0.0.1:1").await;
    let created = create_api_key(
        State(state.clone()),
        axum::Extension(Caller {
            user: user.clone(),
            credential: Credential::Session {
                bearer: String::new(),
            },
        }),
        Json(CreateApiKeyInput {
            label: "Integration".to_owned(),
        }),
    )
    .await
    .unwrap()
    .0;
    (created.secret, upstream.id)
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}")
}

fn console_router(state: AppState) -> Router {
    Router::new()
        .route("/api/me", get(me))
        .route("/api/threads", get(list_threads).post(create_thread))
        .route("/api/threads/{id}", get(read_thread))
        .route("/api/manuals", get(list_manuals).post(create_manual))
        .route_layer(from_fn_with_state(state.clone(), console_auth))
        .with_state(state)
}

fn key_router(state: AppState) -> Router {
    Router::new()
        .route("/api/api-keys", get(list_api_keys).post(create_api_key))
        .route("/api/api-keys/{id}", delete(delete_api_key))
        .route_layer(from_fn_with_state(state.clone(), browser_auth))
        .with_state(state)
}

#[tokio::test]
async fn an_api_key_reaches_the_console_routes_a_session_reaches() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "console-key-user").unwrap();
    let (secret, upstream_id) = key_secret(&state, &user).await;
    let base = serve(console_router(state.clone())).await;
    let client = reqwest::Client::new();

    let me: Value = client
        .get(format!("{base}/api/me"))
        .bearer_auth(&secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["user_id"], json!(user.id));

    let thread: Value = client
        .post(format!("{base}/api/threads"))
        .bearer_auth(&secret)
        .json(&json!({ "title": "Driven by a key", "upstream_id": upstream_id }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A Thread created through the console with a key is recorded as API work,
    // exactly like one created through `/v1`.
    assert_eq!(thread["created_by"], json!("api"));
    let thread_id = thread["id"].as_str().unwrap().to_owned();

    let read: Value = client
        .get(format!("{base}/api/threads/{thread_id}"))
        .bearer_auth(&secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(read["id"], json!(thread_id));

    let listed: Value = client
        .get(format!("{base}/api/threads"))
        .bearer_auth(&secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["total"], json!(1));

    let manual = client
        .post(format!("{base}/api/manuals"))
        .bearer_auth(&secret)
        .json(&json!({ "name": "项目位置", "description": "当需要找项目时读" }))
        .send()
        .await
        .unwrap();
    assert_eq!(manual.status(), reqwest::StatusCode::OK);

    let tampered = client
        .get(format!("{base}/api/threads"))
        .bearer_auth("cyb_console-key-user_wrong-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(tampered.status(), reqwest::StatusCode::UNAUTHORIZED);

    let anonymous = client
        .get(format!("{base}/api/threads"))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_api_key_cannot_manage_api_keys() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "console-key-manager").unwrap();
    let (secret, _upstream_id) = key_secret(&state, &user).await;
    let base = serve(key_router(state.clone())).await;
    let client = reqwest::Client::new();

    for request in [
        client.get(format!("{base}/api/api-keys")),
        client
            .post(format!("{base}/api/api-keys"))
            .json(&json!({ "label": "Nested" })),
        client.delete(format!("{base}/api/api-keys/{}", "0".repeat(32))),
    ] {
        let response = request.bearer_auth(&secret).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FORBIDDEN);
        let body: Value = response.json().await.unwrap();
        assert_eq!(
            body["error"],
            json!("API keys cannot manage API keys; sign in to the console")
        );
    }

    // The same routes still refuse an anonymous caller, so the closed door is
    // the session requirement and not the key.
    let anonymous = client
        .get(format!("{base}/api/api-keys"))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), reqwest::StatusCode::UNAUTHORIZED);
}
