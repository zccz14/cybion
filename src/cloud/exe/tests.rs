//! What has to stay true about eXe devices: the bytes match the other
//! implementations, a sealed call opens only for its own device, and a `bash`
//! call on an eXe device lands in the same ledger a Worker result does.

use super::*;
use crate::cloud::tests::{create_test_thread, insert_record, test_state};
use axum::Router;
use axum::response::IntoResponse;
use axum::routing::any;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

fn seed_from_hex(hex: &str) -> Identity {
    let raw = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&raw);
    Identity::from_seed(seed)
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../tests/exe-vectors.json")).unwrap()
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn ensure_user_db(state: &AppState, user: &User) {
    user_db(state, user, true, |_| Ok(())).await.unwrap();
}

fn pending(name: &str, arguments: Value) -> PendingCall {
    PendingCall {
        id: "call".into(),
        worker_id: "worker".into(),
        address: "address".into(),
        name: name.into(),
        arguments_json: arguments.to_string(),
        status: "queued".into(),
        exe_call_id: None,
        envelope: None,
        cancel_requested_at: None,
        cancel_notified_at: None,
    }
}

#[test]
fn a_user_database_carries_the_exe_schema_and_one_identity() {
    let root = tempfile::tempdir().unwrap();
    let connection = open_user(&root.path().join("exe-schema.sqlite3"), true).unwrap();
    for (table, column) in [
        ("workers", "kind"),
        ("workers", "exe_address"),
        ("worker_calls", "exe_call_id"),
        ("worker_calls", "exe_envelope"),
    ] {
        let present: bool = connection
            .query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?)"),
                [column],
                |r| r.get(0),
            )
            .unwrap();
        assert!(present, "{table}.{column} must exist");
    }
    assert!(stored(&connection).unwrap().is_none());
    let (identity, created_at) = ensure(&connection).unwrap();
    assert_eq!(created_at, now());
    let (again, _) = ensure(&connection).unwrap();
    assert_eq!(again.address(), identity.address());
    // The address is the base58 form of the 32-byte public key, and base58
    // length follows the leading bytes (43 or 44 here), so assert the round
    // trip rather than a character count.
    assert_eq!(parse_address(&identity.address()).unwrap(), identity.public);
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM exe_identity", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn the_shared_vectors_still_describe_this_implementation() {
    let vectors = vectors();
    let caller = seed_from_hex(vectors["keys"]["caller_seed"].as_str().unwrap());
    let device = seed_from_hex(vectors["keys"]["device_seed"].as_str().unwrap());
    assert_eq!(caller.address(), vectors["keys"]["caller_address"]);
    assert_eq!(device.address(), vectors["keys"]["device_address"]);

    let call = CallEnvelope {
        call_id: vectors["call"]["call_id"].as_str().unwrap().into(),
        caller: vectors["call"]["caller"].as_str().unwrap().into(),
        device: vectors["call"]["device"].as_str().unwrap().into(),
        issued_at: vectors["call"]["issued_at"].as_u64().unwrap(),
        expires_at: vectors["call"]["expires_at"].as_u64().unwrap(),
        sealed: vectors["call"]["sealed"].as_str().unwrap().into(),
        sig: vectors["call"]["sig"].as_str().unwrap().into(),
    };
    assert_eq!(
        hex_of(&Sha256::digest(call.transcript().unwrap())),
        vectors["call"]["transcript_sha256"].as_str().unwrap()
    );
    assert!(verify(
        &parse_address(&call.caller).unwrap(),
        &call.transcript().unwrap(),
        &call.sig
    ));
    let context = SealContext {
        direction: "call",
        caller: &call.caller,
        device: &call.device,
        call_id: &call.call_id,
        issued_at: call.issued_at,
        expires_at: call.expires_at,
    };
    let opened = open_sealed(&context, &device, &call.sealed).unwrap();
    let plaintext: Value = serde_json::from_slice(&opened).unwrap();
    let expected: Value =
        serde_json::from_str(vectors["call"]["plaintext"].as_str().unwrap()).unwrap();
    assert_eq!(plaintext["name"], expected["name"]);
    assert_eq!(plaintext["args"], expected["args"]);

    let result: ResultEnvelope = serde_json::from_value(vectors["result"].clone()).unwrap();
    assert_eq!(
        hex_of(&Sha256::digest(result.transcript().unwrap())),
        vectors["result"]["transcript_sha256"].as_str().unwrap()
    );
    assert!(verify(
        &parse_address(&result.device).unwrap(),
        &result.transcript().unwrap(),
        &result.sig
    ));
    let context = SealContext {
        direction: "result",
        caller: &call.caller,
        device: &call.device,
        call_id: &call.call_id,
        issued_at: result.issued_at,
        expires_at: call.expires_at,
    };
    let opened = open_sealed(&context, &caller, &result.sealed).unwrap();
    assert_eq!(
        String::from_utf8(opened).unwrap(),
        vectors["result"]["plaintext"].as_str().unwrap()
    );
}

#[test]
fn a_sealed_call_opens_only_for_its_device() {
    let caller = Identity::from_seed([9u8; 32]);
    let device = Identity::from_seed([3u8; 32]);
    let stranger = Identity::from_seed([5u8; 32]);
    let envelope = CallEnvelope::build(
        &caller,
        &device.address(),
        "11111111-1111-4111-8111-111111111111",
        br#"{"name":"shell","args":"{}"}"#,
        unix(),
        unix() + 60,
    )
    .unwrap();
    let context = SealContext {
        direction: "call",
        caller: &envelope.caller,
        device: &envelope.device,
        call_id: &envelope.call_id,
        issued_at: envelope.issued_at,
        expires_at: envelope.expires_at,
    };
    assert!(open_sealed(&context, &device, &envelope.sealed).is_ok());
    assert!(open_sealed(&context, &stranger, &envelope.sealed).is_err());
    assert!(verify(
        &parse_address(&caller.address()).unwrap(),
        &envelope.transcript().unwrap(),
        &envelope.sig
    ));
    assert!(!verify(
        &parse_address(&stranger.address()).unwrap(),
        &envelope.transcript().unwrap(),
        &envelope.sig
    ));
}

#[test]
fn a_bash_call_is_mapped_to_the_one_verb_exe_implements() {
    let encoded = encode_call(&pending(
        "bash",
        json!({
            "worker_id": "worker",
            "command": "uname -a",
            "cwd": "/tmp",
            "timeout_seconds": 30,
            "summary": "inspect the device"
        }),
    ))
    .expect("bash maps onto shell");
    let plaintext: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(plaintext["name"], "shell");
    let args: Value = serde_json::from_str(plaintext["args"].as_str().unwrap()).unwrap();
    assert_eq!(args["command"], "uname -a");
    assert_eq!(args["cwd"], "/tmp");
    assert_eq!(args["timeout_seconds"], 30);
    assert!(args.get("worker_id").is_none());
    assert!(args.get("summary").is_none());

    assert!(encode_call(&pending("browser_control", json!({"action":"status"}))).is_none());
    assert!(encode_call(&pending("bash", json!({"command":"echo hi"}))).is_some());
    assert!(encode_call(&pending("bash", json!({"note":"no command"}))).is_none());
}

#[test]
fn an_exe_answer_becomes_the_shape_a_worker_returns() {
    let (result, status, error) = tool_result(
        true,
        json!({"ok":true,"output":{"tool":"shell","exit_code":3,"stdout":"out","stderr":"err"}}),
    );
    assert_eq!(status, "completed");
    assert!(error.is_none());
    assert_eq!(result, json!({"exit_code":3,"stdout":"out","stderr":"err"}));

    let (result, status, error) = tool_result(
        false,
        json!({"ok":false,"code":"timeout","error":"too slow"}),
    );
    assert_eq!(status, "failed");
    assert_eq!(error.as_deref(), Some("too slow"));
    assert_eq!(result["code"], "timeout");
}

/// A stand-in for the relay plus a device that answers: it verifies the caller's
/// request signature, opens the sealed call, and seals its own answer with the
/// same key it signs with. Everything the real device would do to prove
/// interop, minus a shell.
struct MockDevice {
    identity: Identity,
    trust: Vec<String>,
    calls: HashMap<String, Value>,
}

async fn mock_relay(
    State(device): State<Arc<AsyncMutex<MockDevice>>>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let path = uri.path().to_owned();
    let address = headers
        .get("x-exe-address")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let timestamp = headers
        .get("x-exe-timestamp")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_default();
    let signature = headers
        .get("x-exe-signature")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut transcript = Vec::new();
    transcript.extend_from_slice(b"eXe/request\0");
    push_lp(&mut transcript, method.as_str().to_uppercase().as_bytes());
    push_lp(&mut transcript, path.as_bytes());
    push_lp(&mut transcript, address.as_bytes());
    push_u64(&mut transcript, timestamp);
    let caller_key = match parse_address(&address) {
        Ok(key) => key,
        Err(_) => return (StatusCode::UNAUTHORIZED, "no address").into_response(),
    };
    if !verify(&caller_key, &transcript, &signature) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"request signature does not verify"})),
        )
            .into_response();
    }
    let mut device = device.lock().await;
    if method == axum::http::Method::GET
        && path == format!("/api/devices/{}", device.identity.address())
    {
        return Json(json!({
            "address": device.identity.address(),
            "registered": true,
            "online": true,
            "platform": "linux",
            "version": "9.9.9",
            "last_seen_at": unix(),
        }))
        .into_response();
    }
    if method == axum::http::Method::POST
        && path == format!("/api/devices/{}/calls", device.identity.address())
    {
        let envelope: CallEnvelope = match serde_json::from_slice(&body) {
            Ok(envelope) => envelope,
            Err(_) => return (StatusCode::BAD_REQUEST, "bad envelope").into_response(),
        };
        if !device.trust.contains(&envelope.caller)
            || !verify(&caller_key, &envelope.transcript().unwrap(), &envelope.sig)
        {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"the relay will not queue this call"})),
            )
                .into_response();
        }
        let context = SealContext {
            direction: "call",
            caller: &envelope.caller,
            device: &envelope.device,
            call_id: &envelope.call_id,
            issued_at: envelope.issued_at,
            expires_at: envelope.expires_at,
        };
        let plaintext = open_sealed(&context, &device.identity, &envelope.sealed).unwrap();
        let call: Value = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(call["name"], "shell");
        let args: Value = serde_json::from_str(call["args"].as_str().unwrap()).unwrap();
        let stdout = format!("ran {}", args["command"].as_str().unwrap());
        let answer = json!({
            "ok": true,
            "output": {"tool": "shell", "exit_code": 0, "stdout": stdout, "stderr": ""},
        })
        .to_string();
        let issued_at = unix();
        let context = SealContext {
            direction: "result",
            caller: &envelope.caller,
            device: &envelope.device,
            call_id: &envelope.call_id,
            issued_at,
            expires_at: envelope.expires_at,
        };
        let recipient = agreement_public_of(&parse_address(&envelope.caller).unwrap()).unwrap();
        let sealed = seal(&context, &recipient, answer.as_bytes()).unwrap();
        let mut result = ResultEnvelope {
            call_id: envelope.call_id.clone(),
            device: envelope.device.clone(),
            ok: true,
            issued_at,
            sealed,
            sig: String::new(),
        };
        result.sig = device.identity.sign(&result.transcript().unwrap());
        device.calls.insert(
            envelope.call_id.clone(),
            serde_json::to_value(&result).unwrap(),
        );
        return Json(json!({"call": {"call_id": envelope.call_id, "status": "queued"}}))
            .into_response();
    }
    let rest = path.strip_prefix("/api/calls/").unwrap_or_default();
    let (call_id, verb) = match rest.split_once('/') {
        Some((call_id, verb)) => (call_id.to_owned(), Some(verb.to_owned())),
        None => (rest.to_owned(), None),
    };
    match (method, verb.as_deref()) {
        (axum::http::Method::GET, None) => match device.calls.get(&call_id) {
            Some(result) => Json(json!({
                "call": {"call_id": call_id, "status": "succeeded", "blob_bytes": null},
                "result": result,
            }))
            .into_response(),
            None => (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"call not found"})),
            )
                .into_response(),
        },
        (axum::http::Method::POST, Some("ack")) => {
            device.calls.remove(&call_id);
            StatusCode::OK.into_response()
        }
        (axum::http::Method::POST, Some("cancel")) => StatusCode::OK.into_response(),
        _ => (StatusCode::NOT_FOUND, "no route").into_response(),
    }
}

struct MockFixture {
    _root: tempfile::TempDir,
    state: AppState,
    user: User,
    device: Arc<AsyncMutex<MockDevice>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for MockFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn mock_fixture(seed: [u8; 32]) -> MockFixture {
    let (root, mut state) = test_state();
    let user = user_for_subject(&state, "exe-mock-owner").unwrap();
    ensure_user_db(&state, &user).await;
    let (address, _) = identity_for(&state, &user).await.unwrap();
    let device = Arc::new(AsyncMutex::new(MockDevice {
        identity: Identity::from_seed(seed),
        trust: vec![address],
        calls: HashMap::new(),
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    state.exe_api_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn({
        let device = device.clone();
        async move {
            axum::serve(
                listener,
                Router::new().fallback(any(mock_relay)).with_state(device),
            )
            .await
            .unwrap()
        }
    });
    MockFixture {
        _root: root,
        state,
        user,
        device,
        server,
    }
}

#[tokio::test]
async fn a_bash_call_runs_on_an_exe_device_and_lands_in_the_thread() {
    let fixture = mock_fixture([17u8; 32]).await;
    let state = fixture.state.clone();
    let user = fixture.user.clone();
    let thread = create_test_thread(&state, &user).await;
    let worker_id = Uuid::new_v4().to_string();
    let (worker, device_address) = (
        worker_id.clone(),
        fixture.device.lock().await.identity.address(),
    );
    user_db(&state, &user, false, move |c| {
        insert_device(
            c,
            &worker,
            "Phone",
            &device_address,
            &DeviceStatus {
                registered: true,
                online: true,
                platform: Some("linux".into()),
                version: Some("9.9.9".into()),
                last_seen_at: Some(now()),
            },
        )
    })
    .await
    .unwrap();
    let input = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |c| {
            c.execute(
                "UPDATE threads SET status='running' WHERE id=?",
                [&thread_id],
            )?;
            Ok(insert_record(
                c,
                &thread_id,
                "input",
                json!({"role":"user","content":"hello"}),
            ))
        }
    })
    .await
    .unwrap();
    let call_id = user_db(&state, &user, false, {
        let worker = worker_id.clone();
        let thread_id = thread.id.clone();
        move |c| {
            enqueue_worker_call_tx(
                c,
                &worker,
                &thread_id,
                input,
                "call-1",
                "function_call_output",
                "bash",
                &json!({"worker_id": worker, "summary": "inspect the device", "command": "echo hi"}),
            )
        }
    })
    .await
    .unwrap();

    for _ in 0..60 {
        drive_once(&state).await.unwrap();
        let status: String = user_db(&state, &user, false, {
            let call_id = call_id.clone();
            move |c| {
                Ok(c.query_row(
                    "SELECT status FROM worker_calls WHERE id=?",
                    [&call_id],
                    |r| r.get(0),
                )?)
            }
        })
        .await
        .unwrap();
        if status != "queued" && status != "delivered" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (status, result_json) = user_db(&state, &user, false, {
        let call_id = call_id.clone();
        move |c| {
            Ok(c.query_row(
                "SELECT status,result_json FROM worker_calls WHERE id=?",
                [&call_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            )?)
        }
    })
    .await
    .unwrap();
    assert_eq!(status, "completed");
    let result: Value = serde_json::from_str(&result_json.unwrap()).unwrap();
    assert_eq!(result["exit_code"], 0);
    assert_eq!(result["stdout"], "ran echo hi");

    let history = history_for(&state, &user, thread.id.clone(), 0)
        .await
        .unwrap();
    let output = history
        .iter()
        .find(|record| record.kind == "tool_output")
        .expect("the result lands in the Thread as a tool output");
    assert_eq!(output.payload["call_id"], "call-1");
    assert_eq!(
        serde_json::from_str::<Value>(output.payload["output"].as_str().unwrap()).unwrap(),
        result
    );
    // The relay row is acknowledged once the Controller owns the answer.
    assert!(fixture.device.lock().await.calls.is_empty());
}

#[tokio::test]
async fn an_offline_exe_device_and_a_missing_verb_are_refused_before_queueing() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "exe-offline-owner").unwrap();
    let thread = create_test_thread(&state, &user).await;
    ensure_user_db(&state, &user).await;
    let worker_id = Uuid::new_v4().to_string();
    let (worker, seeded) = (worker_id.clone(), worker_id.clone());
    user_db(&state, &user, false, move |c| {
        insert_device(
            c,
            &seeded,
            "Phone",
            &Identity::from_seed([2u8; 32]).address(),
            &DeviceStatus::default(),
        )
    })
    .await
    .unwrap();
    let input = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |c| {
            c.execute(
                "UPDATE threads SET status='running' WHERE id=?",
                [&thread_id],
            )?;
            Ok(insert_record(
                c,
                &thread_id,
                "input",
                json!({"role":"user","content":"hello"}),
            ))
        }
    })
    .await
    .unwrap();
    let error = user_db(&state, &user, false, {
        let worker = worker_id.clone();
        let thread_id = thread.id.clone();
        move |c| {
            enqueue_worker_call_tx(
                c,
                &worker,
                &thread_id,
                input,
                "call-1",
                "function_call_output",
                "bash",
                &json!({"command": "echo hi"}),
            )
        }
    })
    .await
    .unwrap_err();
    assert!(error.message.contains("is offline"), "{}", error.message);

    // An online device still refuses a verb it does not implement.
    user_db(&state, &user, false, move |c| {
        c.execute(
            "UPDATE workers SET status='online',last_seen_at=? WHERE id=?",
            params![now(), worker],
        )?;
        Ok(())
    })
    .await
    .unwrap();
    let error = user_db(&state, &user, false, {
        let worker = worker_id.clone();
        let thread_id = thread.id.clone();
        move |c| {
            enqueue_worker_call_tx(
                c,
                &worker,
                &thread_id,
                input,
                "call-2",
                "function_call_output",
                "browser_control",
                &json!({"action": "status"}),
            )
        }
    })
    .await
    .unwrap_err();
    assert!(
        error.message.contains("executes shell commands only"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn adding_a_device_lists_it_once_and_shows_the_account_address() {
    let (_root, mut state) = test_state();
    // A test must never reach the real relay.
    state.exe_api_url = "http://127.0.0.1:9".into();
    let user = user_for_subject(&state, "exe-add-owner").unwrap();
    let identity = BrowserIdentity {
        user: user.clone(),
        bearer: "fixture".into(),
    };
    let device = Identity::from_seed([11u8; 32]).address();
    let added = add_device(
        State(state.clone()),
        axum::Extension(identity.clone()),
        Json(AddDeviceInput {
            address: device.clone(),
            label: Some("Phone".into()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(added.0["address"], device);
    assert_eq!(added.0["label"], "Phone");
    assert_eq!(added.0["status"], "offline");

    let duplicate = add_device(
        State(state.clone()),
        axum::Extension(identity.clone()),
        Json(AddDeviceInput {
            address: device.clone(),
            label: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.status, StatusCode::CONFLICT);

    let read = read(State(state.clone()), axum::Extension(identity))
        .await
        .unwrap();
    let address = read.0["address"].as_str().unwrap();
    let listed = read.0["devices"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["address"], device);
    assert_eq!(listed[0]["label"], "Phone");

    // The address is the public half of a key the Controller holds; asking
    // twice must not mint a second identity.
    let again = identity_for(&state, &user).await.unwrap();
    assert_eq!(again.0, address);
}

#[tokio::test]
async fn a_stale_offline_mirror_does_not_refuse_a_device_the_relay_reports_online() {
    let fixture = mock_fixture([21u8; 32]).await;
    let state = fixture.state.clone();
    let user = fixture.user.clone();
    let thread = create_test_thread(&state, &user).await;
    let worker_id = Uuid::new_v4().to_string();
    let (worker, address) = (
        worker_id.clone(),
        fixture.device.lock().await.identity.address(),
    );
    // The mirror says offline, because that is what the last listing wrote and
    // nothing has asked the relay since.
    user_db(&state, &user, false, move |c| {
        insert_device(c, &worker, "Phone", &address, &DeviceStatus::default())
    })
    .await
    .unwrap();
    let input = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |c| {
            c.execute(
                "UPDATE threads SET status='running' WHERE id=?",
                [&thread_id],
            )?;
            Ok(insert_record(
                c,
                &thread_id,
                "input",
                json!({"role":"user","content":"hello"}),
            ))
        }
    })
    .await
    .unwrap();

    let call_id = super::super::enqueue_worker_call(
        &state,
        &user,
        &worker_id,
        &thread.id,
        input,
        "call-1".to_owned(),
        "function_call_output".to_owned(),
        "bash".to_owned(),
        json!({"worker_id": worker_id, "summary": "inspect the device", "command": "echo hi"}),
    )
    .await
    .expect("a device the relay reports online must not be refused");

    let call_status: String = user_db(&state, &user, false, {
        let call_id = call_id.clone();
        move |c| {
            Ok(c.query_row(
                "SELECT status FROM worker_calls WHERE id=?",
                [&call_id],
                |r| r.get(0),
            )?)
        }
    })
    .await
    .unwrap();
    assert_eq!(call_status, "queued");
    let (status, last_seen) = user_db(&state, &user, false, {
        let worker = worker_id.clone();
        move |c| {
            Ok(c.query_row(
                "SELECT status,last_seen_at FROM workers WHERE id=?",
                [&worker],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)),
            )?)
        }
    })
    .await
    .unwrap();
    assert_eq!(status, "online", "the re-probe stores what the relay said");
    assert!(last_seen.is_some_and(|seen| seen > 0));
}

#[tokio::test]
async fn a_device_stays_refused_when_the_relay_cannot_be_reached() {
    let (_root, mut state) = test_state();
    // A test must never reach the real relay.
    state.exe_api_url = "http://127.0.0.1:9".into();
    let user = user_for_subject(&state, "exe-stale-mirror-owner").unwrap();
    ensure_user_db(&state, &user).await;
    let thread = create_test_thread(&state, &user).await;
    let worker_id = Uuid::new_v4().to_string();
    let (worker, address) = (worker_id.clone(), Identity::from_seed([23u8; 32]).address());
    user_db(&state, &user, false, move |c| {
        insert_device(c, &worker, "Phone", &address, &DeviceStatus::default())
    })
    .await
    .unwrap();
    let input = user_db(&state, &user, false, {
        let thread_id = thread.id.clone();
        move |c| {
            c.execute(
                "UPDATE threads SET status='running' WHERE id=?",
                [&thread_id],
            )?;
            Ok(insert_record(
                c,
                &thread_id,
                "input",
                json!({"role":"user","content":"hello"}),
            ))
        }
    })
    .await
    .unwrap();

    let error = super::super::enqueue_worker_call(
        &state,
        &user,
        &worker_id,
        &thread.id,
        input,
        "call-1".to_owned(),
        "function_call_output".to_owned(),
        "bash".to_owned(),
        json!({"worker_id": worker_id, "summary": "inspect the device", "command": "echo hi"}),
    )
    .await
    .unwrap_err();
    // An unreachable relay must not soften the gate: an offline mirror still
    // refuses, exactly as it did before the re-probe existed.
    assert!(error.message.contains("is offline"), "{}", error.message);
}
