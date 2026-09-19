use super::*;
use crate::cloud::tests::{create_test_thread, insert_record, test_state};

async fn fixture() -> (tempfile::TempDir, AppState, User, ThreadView, String, i64) {
    let (root, state) = test_state();
    let user = user_for_subject(&state, "protocol-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let worker = Uuid::new_v4().to_string();
    let input=user_db(&state,&user,false,{let worker=worker.clone();let thread=thread.id.clone();move|c|{
        c.execute("UPDATE threads SET status='running' WHERE id=?",[&thread])?;
        c.execute("INSERT INTO workers(id,label,token_hash,status,last_seen_at,created_at,version) VALUES(?,'fixture',?,'online',?,?,'0.2.0')",params![worker,hash_secret("fixture"),now(),now()])?;
        Ok(insert_record(c,&thread,"input",json!({"role":"user","content":"fixture"})))
    }}).await.unwrap();
    (root, state, user, thread, worker, input)
}
async fn queued(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    worker: &str,
    input: i64,
    provider_id: &str,
) -> String {
    enqueue_worker_call(
        state,
        user,
        worker,
        &thread.id,
        input,
        provider_id.into(),
        "function_call_output".into(),
        "bash".into(),
        json!({"command":"echo once"}),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn same_boot_replays_same_ids_new_boot_loses_only_delivered_calls() {
    let (_root, state, user, thread, worker, input) = fixture().await;
    let boot = Uuid::new_v4().to_string();
    let first = queued(&state, &user, &thread, &worker, input, "first").await;
    user_db(&state, &user, false, {
        let worker = worker.clone();
        let boot = boot.clone();
        let first = first.clone();
        move |c| {
            assert!(register(c, &worker, Some(&boot), Some("0.2.0"))?.is_empty());
            assert_eq!(claim(c, &worker, Some(&boot))?.unwrap().id, first);
            assert_eq!(
                register(c, &worker, Some(&boot), Some("0.2.0"))?,
                VecDeque::from([first])
            );
            Ok(())
        }
    })
    .await
    .unwrap();
    let second = queued(&state, &user, &thread, &worker, input, "second").await;
    let next = Uuid::new_v4().to_string();
    user_db(&state, &user, false, {
        let worker = worker.clone();
        let boot = boot.clone();
        let next = next.clone();
        move |c| {
            assert!(register(c, &worker, Some(&next), Some("0.2.0"))?.is_empty());
            assert!(allow_report(c, &worker, Some(&boot)).is_err());
            assert_eq!(claim(c, &worker, Some(&next))?.unwrap().id, second);
            Ok(())
        }
    })
    .await
    .unwrap();
    let history = history_for(&state, &user, thread.id.clone()).await.unwrap();
    let lost = history.iter().find(|r| r.kind == "tool_output").unwrap();
    assert_eq!(lost.payload["call_id"], "first");
    assert!(lost.payload["output"].as_str().unwrap().contains("unknown"));
    for _ in 0..2 {
        let _ = worker_result(
            State(state.clone()),
            AxumPath((user.id.clone(), worker.clone(), first.clone())),
            axum::Extension(user.clone()),
            Json(WorkerResultInput {
                result: json!({"stdout":"late actual result"}),
                failed: false,
                error: None,
            }),
        )
        .await
        .unwrap();
    }
    let history = history_for(&state, &user, thread.id).await.unwrap();
    assert_eq!(
        history.iter().filter(|r| r.kind == "tool_output").count(),
        1
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| r.payload["type"] == "late_worker_result")
            .count(),
        1
    );
}

#[tokio::test]
async fn upgrade_drains_tools_blocks_new_delivery_and_confirms_actual_version() {
    let (_root, state, user, thread, worker, input) = fixture().await;
    let boot = Uuid::new_v4().to_string();
    let call = queued(&state, &user, &thread, &worker, input, "call").await;
    user_db(&state, &user, false, {
        let worker = worker.clone();
        let boot = boot.clone();
        move |c| {
            register(c, &worker, Some(&boot), Some("0.2.0"))?;
            claim(c, &worker, Some(&boot))?.unwrap();
            queue_upgrade(c, &worker, "v0.2.1")?;
            assert!(ready_upgrade(c, &worker, Some(&boot))?.is_none());
            assert!(claim(c, &worker, Some(&boot))?.is_none());
            Ok(())
        }
    })
    .await
    .unwrap();
    let _ = worker_result(
        State(state.clone()),
        AxumPath((user.id.clone(), worker.clone(), call)),
        axum::Extension(user.clone()),
        Json(WorkerResultInput {
            result: json!({"stdout":"done"}),
            failed: false,
            error: None,
        }),
    )
    .await
    .unwrap();
    user_db(&state, &user, false, {
        let worker = worker.clone();
        let boot = boot.clone();
        move |c| {
            let event = ready_upgrade(c, &worker, Some(&boot))?.unwrap();
            assert_eq!(event["version"], "v0.2.1");
            assert_eq!(event["boot_id"], boot);
            c.execute(
                "UPDATE workers SET upgrade_status='installing' WHERE id=?",
                [&worker],
            )?;
            register(c, &worker, Some(&Uuid::new_v4().to_string()), Some("0.2.1"))?;
            assert_eq!(
                c.query_row(
                    "SELECT upgrade_status FROM workers WHERE id=?",
                    [&worker],
                    |r| r.get::<_, String>(0)
                )?,
                "completed"
            );
            assert!(queue_upgrade(c, &worker, "v0.2.0").is_err());
            queue_upgrade(c, &worker, "v0.2.2")?;
            c.execute(
                "UPDATE workers SET upgrade_status='installing' WHERE id=?",
                [&worker],
            )?;
            register(c, &worker, Some(&Uuid::new_v4().to_string()), Some("0.2.1"))?;
            assert_eq!(
                c.query_row(
                    "SELECT upgrade_status FROM workers WHERE id=?",
                    [&worker],
                    |r| r.get::<_, String>(0)
                )?,
                "failed"
            );
            Ok(())
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn upgrades_require_owner_online_capable_worker_and_browser_authentication() {
    let (_root, state, user, _thread, worker, _) = fixture().await;
    assert_eq!(
        user_db(&state, &user, false, {
            let worker = worker.clone();
            move |c| queue_upgrade(c, &worker, "v0.2.1")
        })
        .await
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    let other = user_for_subject(&state, "other-user").unwrap();
    create_test_thread(&state, &other).await;
    let error = request_upgrade(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: other,
            bearer: "fixture".into(),
        }),
        AxumPath(worker.clone()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::NOT_FOUND);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/api/workers/{worker}/upgrade",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app(state)).await.unwrap() });
    assert_eq!(
        reqwest::Client::new()
            .post(url)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    server.abort();
}

#[tokio::test]
async fn legacy_workers_are_not_replayed_or_silently_assigned_new_boots() {
    let (_root, state, user, thread, worker, input) = fixture().await;
    queued(&state, &user, &thread, &worker, input, "call").await;
    user_db(&state, &user, false, move |c| {
        assert!(register(c, &worker, None, None)?.is_empty());
        claim(c, &worker, None)?.unwrap();
        assert!(register(c, &worker, None, None)?.is_empty());
        assert!(claim(c, &worker, None)?.is_none());
        let boot = Uuid::new_v4().to_string();
        register(c, &worker, Some(&boot), Some("0.2.0"))?;
        assert!(register(c, &worker, None, None).is_err());
        Ok(())
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn doctor_authenticates_without_overwriting_the_live_process_version() {
    let (_root, state, user, _thread, worker, _) = fixture().await;
    user_db(&state, &user, false, {
        let worker = worker.clone();
        move |c| {
            register(c, &worker, Some(&Uuid::new_v4().to_string()), Some("0.2.0"))?;
            Ok(())
        }
    })
    .await
    .unwrap();
    let _ = worker_heartbeat(
        State(state.clone()),
        HeaderMap::new(),
        AxumPath((user.id.clone(), worker.clone())),
        axum::Extension(user.clone()),
        Json(WorkerHeartbeat {
            hostname: Some("doctor".into()),
            version: Some("0.1.4".into()),
        }),
    )
    .await
    .unwrap();
    user_db(&state, &user, false, move |c| {
        assert_eq!(
            c.query_row("SELECT version FROM workers WHERE id=?", [worker], |r| {
                r.get::<_, String>(0)
            })?,
            "0.2.0"
        );
        Ok(())
    })
    .await
    .unwrap();
}
