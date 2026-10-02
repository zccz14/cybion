use super::*;
use crate::cloud::tests::{create_test_thread, insert_record, test_state};

const THREAD: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
fn fixture() -> (tempfile::TempDir, Connection, Connection, Connection) {
    let root = tempfile::tempdir().unwrap();
    let a = open_user(&root.path().join("a.sqlite3"), true).unwrap();
    let b = open_user(&root.path().join("b.sqlite3"), true).unwrap();
    let c = open_user(&root.path().join("c.sqlite3"), true).unwrap();
    a.execute("INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES(?,'Shared title','model','idle',1,1),(?,'Private other Thread','model','idle',1,1)",params![THREAD,OTHER]).unwrap();
    (root, a, b, c)
}
fn grant_b(a: &mut Connection) -> Grant {
    change_grant(a, "a", THREAD, "b", GrantAction::Grant).unwrap();
    sync_grants(a, "a").unwrap();
    get_grant(a, THREAD, "b").unwrap()
}
fn count(c: &Connection, table: &str) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn owner_only_exact_existing_recipients_and_idempotent_audit() {
    let (root, mut a, mut b, c) = fixture();
    for recipient in ["a", " a ", " b ", "../escape", "missing"] {
        assert!(change_grant(&mut a, "a", THREAD, recipient, GrantAction::Grant).is_err());
    }
    assert!(!root.path().join("missing.sqlite3").exists());
    assert!(change_grant(&mut b, "b", THREAD, "c", GrantAction::Grant).is_err());
    let g = grant_b(&mut a);
    change_grant(&mut a, "a", THREAD, "b", GrantAction::Grant).unwrap();
    assert_eq!(g.grant_id, get_grant(&a, THREAD, "b").unwrap().grant_id);
    assert_eq!(count(&a, "thread_grants"), 1);
    assert_eq!(count(&a, "history_records"), 1);
    assert_eq!(count(&b, "threads"), 0);
    assert_eq!(count(&b, "history_records"), 0);
    assert_eq!(count(&b, "shared_threads"), 1);
    assert_eq!(count(&c, "shared_threads"), 0);
    assert_eq!(load_thread(&a, THREAD).unwrap().display_status, "ready");
    assert!(latest_protocol_record_id(&a, THREAD).is_err());
    let source = root.path().join("a.sqlite3");
    assert!(
        read_source(&source, "b", THREAD, None, |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .is_ok()
    );
    assert_eq!(
        read_source(&source, "c", THREAD, None, |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .unwrap_err()
        .status,
        StatusCode::NOT_FOUND
    );
    assert!(
        read_source(&source, "b", OTHER, None, |c, g| shared_view(
            c, "a", OTHER, g
        ))
        .is_err()
    );
    // A forged discovery cache never creates a grant in the source database.
    c.execute("INSERT INTO shared_threads SELECT owner_user_id,thread_id,grant_id,permission,revoked_at,revision,shared_at,hidden_at FROM shared_threads WHERE 0",[]).unwrap();
    c.execute(
        "INSERT INTO shared_threads VALUES('a',?,?,'viewer',NULL,1,1,NULL)",
        params![THREAD, g.grant_id],
    )
    .unwrap();
    assert!(
        read_source(&source, "c", THREAD, Some(&g.grant_id), |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .is_err()
    );
}

#[test]
fn sync_failure_recovery_tombstone_order_and_regrant_hidden_reset() {
    let (root, mut a, b, _) = fixture();
    let first = grant_b(&mut a);
    b.execute("UPDATE shared_threads SET hidden_at=2", [])
        .unwrap();
    b.execute_batch("CREATE TRIGGER fail_sync BEFORE UPDATE ON shared_threads BEGIN SELECT RAISE(FAIL,'busy'); END;").unwrap();
    change_grant(&mut a, "a", THREAD, "b", GrantAction::Revoke).unwrap();
    change_grant(&mut a, "a", THREAD, "b", GrantAction::Revoke).unwrap();
    sync_grants(&a, "a").unwrap();
    assert_eq!(get_grant(&a, THREAD, "b").unwrap().synced_revision, 1);
    assert!(
        read_source(&root.path().join("a.sqlite3"), "b", THREAD, None, |c, g| {
            shared_view(c, "a", THREAD, g)
        })
        .is_err()
    );
    assert_eq!(count(&a, "history_records"), 2);
    drop(a);
    let mut a = open_user(&root.path().join("a.sqlite3"), false).unwrap();
    b.execute_batch("DROP TRIGGER fail_sync").unwrap();
    sync_grants(&a, "a").unwrap();
    assert!(discovery(&b, ListQuery::default()).unwrap().0.is_empty());
    // Retry an older projection after a newer revocation: it must not resurrect it.
    a.execute(
        "UPDATE thread_grants SET revision=1,synced_revision=0,revoked_at=NULL",
        [],
    )
    .unwrap();
    sync_grants(&a, "a").unwrap();
    let cached: (i64, Option<i64>) = b
        .query_row("SELECT revision,revoked_at FROM shared_threads", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(cached.0, 2);
    assert!(cached.1.is_some());
    a.execute(
        "UPDATE thread_grants SET revision=2,synced_revision=2,revoked_at=2",
        [],
    )
    .unwrap();
    change_grant(&mut a, "a", THREAD, "b", GrantAction::Grant).unwrap();
    let second = get_grant(&a, THREAD, "b").unwrap();
    assert_ne!(first.grant_id, second.grant_id);
    sync_grants(&a, "a").unwrap();
    let hidden: Option<i64> = b
        .query_row("SELECT hidden_at FROM shared_threads", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hidden, None);
    assert_eq!(discovery(&b, ListQuery::default()).unwrap().0.len(), 1);
    assert!(
        read_source(
            &root.path().join("a.sqlite3"),
            "b",
            THREAD,
            Some(&first.grant_id),
            |c, g| shared_view(c, "a", THREAD, g)
        )
        .is_err()
    );
    b.execute("UPDATE shared_threads SET hidden_at=3", [])
        .unwrap();
    a.execute("UPDATE thread_grants SET synced_revision=0", [])
        .unwrap();
    sync_grants(&a, "a").unwrap();
    assert_eq!(
        b.query_row("SELECT hidden_at FROM shared_threads", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn deletion_revoke_is_atomic_preserves_tombstones_and_archive_does_not_revoke() {
    let (root, mut a, b, _) = fixture();
    grant_b(&mut a);
    a.execute(
        "UPDATE threads SET archived_at=2,status='running' WHERE id=?",
        [THREAD],
    )
    .unwrap();
    let source = root.path().join("a.sqlite3");
    assert!(
        read_source(&source, "b", THREAD, None, |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .is_ok()
    );
    let tx = a.transaction().unwrap();
    tx.execute("DELETE FROM threads WHERE id=?", [THREAD])
        .unwrap();
    assert!(get_grant(&tx, THREAD, "b").unwrap().revoked_at.is_some());
    tx.rollback().unwrap();
    assert!(get_grant(&a, THREAD, "b").unwrap().revoked_at.is_none());
    a.execute("DELETE FROM threads WHERE id=?", [THREAD])
        .unwrap();
    assert_eq!(count(&a, "thread_grants"), 1);
    assert!(
        read_source(&source, "b", THREAD, None, |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .is_err()
    );
    assert_eq!(get_grant(&a, THREAD, "b").unwrap().revision, 2);
    assert_eq!(get_grant(&a, THREAD, "b").unwrap().synced_revision, 1);
    sync_grants(&a, "a").unwrap();
    assert!(discovery(&b, ListQuery::default()).unwrap().0.is_empty());
    check_user_foreign_keys(&a).unwrap();
}

#[test]
fn source_read_is_read_only_atomic_and_missing_files_are_never_created() {
    let (root, mut a, b, _) = fixture();
    grant_b(&mut a);
    let path = root.path().join("a.sqlite3");
    let title = read_source(&path, "b", THREAD, None, |c, _| {
        assert!(
            c.execute("UPDATE threads SET title='forbidden'", [])
                .is_err()
        );
        // An already authorized read retains its transaction snapshot. Revocation
        // blocks the next request, not bytes selected before it committed.
        change_grant(&mut a, "a", THREAD, "b", GrantAction::Revoke).unwrap();
        Ok(load_thread(c, THREAD)?.title)
    })
    .unwrap();
    assert_eq!(title, "Shared title");
    assert!(
        read_source(&path, "b", THREAD, None, |c, g| shared_view(
            c, "a", THREAD, g
        ))
        .is_err()
    );
    assert!(existing_reader(&root.path().join("missing.sqlite3")).is_err());
    assert!(!root.path().join("missing.sqlite3").exists());
    drop(b);
    fs::rename(root.path().join("b.sqlite3"), root.path().join("b.offline")).unwrap();
    sync_grants(&a, "a").unwrap();
    assert!(!root.path().join("b.sqlite3").exists());
    assert_eq!(get_grant(&a, THREAD, "b").unwrap().synced_revision, 1);
}

#[test]
fn discovery_is_bounded_keyset_paged_and_hidden_is_local() {
    let (_root, mut a, b, _) = fixture();
    grant_b(&mut a);
    for n in 3..=35 {
        let id = Uuid::from_u128(n).to_string();
        b.execute(
            "INSERT INTO shared_threads VALUES('a',?,?,'viewer',NULL,1,1,NULL)",
            params![id, format!("g{n}")],
        )
        .unwrap();
    }
    let mut cursor = None;
    let mut seen = HashSet::new();
    loop {
        let (rows, next) = discovery(
            &b,
            ListQuery {
                cursor,
                limit: Some(7),
                hidden: None,
            },
        )
        .unwrap();
        assert!(rows.len() <= 7);
        for row in rows {
            assert!(seen.insert(row.cursor.thread));
        }
        if next.is_none() {
            break;
        }
        cursor = next;
    }
    assert_eq!(seen.len(), 34);
    for limit in [0, 31, usize::MAX] {
        assert!(
            discovery(
                &b,
                ListQuery {
                    limit: Some(limit),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
    for cursor in ["bad".to_owned(), "x".repeat(1025), hex::encode(b"{}")] {
        assert!(
            discovery(
                &b,
                ListQuery {
                    cursor: Some(cursor),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
    b.execute(
        "UPDATE shared_threads SET hidden_at=1 WHERE thread_id=?",
        [THREAD],
    )
    .unwrap();
    let hidden = discovery(
        &b,
        ListQuery {
            hidden: Some(true),
            ..Default::default()
        },
    )
    .unwrap()
    .0;
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].cursor.thread, THREAD);
    assert!(get_grant(&a, THREAD, "b").unwrap().revoked_at.is_none());
}

#[test]
fn history_projection_preserves_content_images_checkpoints_and_screenshot_provenance() {
    let (_root, mut a, _, _) = fixture();
    insert_record(
        &a,
        THREAD,
        "input",
        json!({"role":"user","content":[{"type":"input_text","text":"hello","private":"removed"},{"type":"input_image","image_url":"data:image/png;base64,png"}],"private":"removed"}),
    );
    insert_record(
        &a,
        OTHER,
        "input",
        json!({"role":"user","content":"OTHER SECRET"}),
    );
    insert_record(
        &a,
        THREAD,
        "response_output",
        json!({"type":"reasoning","id":"r","summary":[{"type":"summary_text","text":"summary","private":"removed"}],"encrypted_content":"SECRET","content":[{"text":"hidden"}]}),
    );
    insert_record(
        &a,
        THREAD,
        "checkpoint",
        json!({"role":"developer","content":"# Checkpoint"}),
    );
    let screenshot = insert_record(
        &a,
        THREAD,
        "tool_output",
        json!({"type":"function_call_output","call_id":"s","output":"{\"data\":\"png\"}"}),
    );
    a.execute("UPDATE history_records SET worker_screenshot=1,worker_owner_user_id='private-route' WHERE id=?",[screenshot]).unwrap();
    insert_record(
        &a,
        THREAD,
        "tool_output",
        json!({"type":"function_call_output","call_id":"fake","output":"{\"data\":\"png\"}","worker_screenshot":true}),
    );
    grant_b(&mut a);
    let records = shared_records(load_history(&a, THREAD, 0).unwrap());
    assert_eq!(records.len(), 5);
    assert!(records.iter().any(|r| r.id == screenshot && r.screenshot));
    assert_eq!(records.iter().filter(|r| r.screenshot).count(), 1);
    let json = serde_json::to_string(&records).unwrap();
    for private in [
        "OTHER SECRET",
        "SECRET",
        "hidden",
        "private-route",
        "removed",
        "thread_share",
        "grantee_user_id",
    ] {
        assert!(!json.contains(private), "{private}");
    }
    for text in [
        "summary",
        "# Checkpoint",
        "data:image/png;base64,png",
        "function_call_output",
    ] {
        assert!(json.contains(text), "{text}");
    }
    let window = thread_history_tail(&a, THREAD).unwrap();
    assert_eq!(window.records[0].thread_id, THREAD);
    assert!(
        shared_records(
            thread_history_older_page(&a, THREAD, i64::MAX)
                .unwrap()
                .records
        )
        .iter()
        .all(|r| r.thread_id == THREAD)
    );
    assert!(thread_history_older_page(&a, THREAD, 0).is_err());
    let persisted = load_history(&a, THREAD, 0).unwrap();
    assert!(
        serde_json::to_string(&persisted)
            .unwrap()
            .contains("SECRET")
    );
}

#[test]
fn schema_23_upgrade_preserves_data_and_does_not_grant_existing_users() {
    let (_root, mut a, _, _) = fixture();
    a.execute_batch("DROP TRIGGER threads_revoke_shares; DROP TABLE thread_grants; DROP TABLE shared_threads; PRAGMA user_version=23;").unwrap();
    let id = insert_record(
        &a,
        THREAD,
        "input",
        json!({"role":"user","content":"retained"}),
    );
    ensure_user_schema(&mut a).unwrap();
    ensure_user_schema(&mut a).unwrap();
    assert_eq!(count(&a, "thread_grants"), 0);
    assert_eq!(count(&a, "shared_threads"), 0);
    assert_eq!(load_history(&a, THREAD, 0).unwrap()[0].id, id);
    assert_eq!(
        a.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        24
    );
    check_user_foreign_keys(&a).unwrap();
}

#[tokio::test]
async fn http_browser_auth_readonly_isolation_live_response_revocation_and_api_keys() {
    use crate::cloud::settings_tests::base64url;
    use ed25519_dalek::{Signer, SigningKey};
    let (_root, state) = test_state();
    let a = user_for_subject(&state, "a").unwrap();
    let b = user_for_subject(&state, "b").unwrap();
    let c = user_for_subject(&state, "c").unwrap();
    let t = create_test_thread(&state, &a).await;
    let private = create_test_thread(&state, &a).await;
    create_test_thread(&state, &b).await;
    create_test_thread(&state, &c).await;
    let id = t.id.clone();
    user_db(&state,&a,false,move |db|{
        let input=insert_record(db,&id,"input",json!({"role":"user","content":"visible original input"}));
        let mut snapshot=ResponseState::default();
        snapshot.request_id=Some("SECRET_REQUEST_ID".into());snapshot.turn_state=Some("SECRET_TURN_STATE".into());
        snapshot.output=serde_json::from_value(json!([{"item":{"id":"live","type":"message","role":"assistant","content":[{"type":"output_text","text":"visible live output","private":"SECRET_EXTRA"}],"private":"SECRET_EXTRA"},"done":false,"record_id":null}])).unwrap();
        db.execute("INSERT INTO reasoning_audits(thread_id,input_record_id,model,status,started_at) VALUES(?,?,'m','in_flight',1)",params![id,input])?;
        db.execute("INSERT INTO response_states VALUES(?,?)",params![db.last_insert_rowid(),serde_json::to_string(&snapshot).unwrap()])?;
        db.execute("UPDATE threads SET status='running',external_ref='SECRET_REF' WHERE id=?",[id])?;
        Ok(())
    }).await.unwrap();
    let key = SigningKey::from_bytes(&[59; 32]);
    let jwks = json!({"keys":[{"kid":"test","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":base64url(&key.verifying_key().to_bytes())}]});
    let issuer_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", issuer_listener.local_addr().unwrap());
    let issuer_task = tokio::spawn(async move {
        axum::serve(
            issuer_listener,
            Router::new().route("/jwks", get(move || async { Json(jwks) })),
        )
        .await
        .unwrap()
    });
    state
        .auth
        .set(
            AuthMiniLayer::from_issuer(&issuer, AUTH_AUDIENCE, JwksCachePolicy::default())
                .await
                .unwrap(),
        )
        .ok()
        .unwrap();
    let token = |user: &str| {
        let claims = json!({"sub":user,"sid":format!("{user}-session"),"iss":issuer,"aud":AUTH_AUDIENCE,"amr":["webauthn"],"typ":"access","iat":now(),"exp":now()+120});
        let signed = format!(
            "{}.{}",
            base64url(br#"{"alg":"EdDSA","kid":"test"}"#),
            base64url(claims.to_string().as_bytes())
        );
        format!(
            "{signed}.{}",
            base64url(&key.sign(signed.as_bytes()).to_bytes())
        )
    };
    let ta = token("a");
    let tb = token("b");
    let tc = token("c");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn({
        let state = state.clone();
        async move { axum::serve(listener, app(state)).await.unwrap() }
    });
    let client = reqwest::Client::new();
    let grant_url = format!("{base}/api/threads/{}/grants/b", t.id);
    let shared = format!("{base}/api/shared-threads/a/{}", t.id);
    assert_eq!(
        client.get(&shared).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .get(&shared)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .put(&grant_url)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let g = client
        .put(&grant_url)
        .bearer_auth(&ta)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(g["permission"], "viewer");
    for suffix in ["", "/history/window", "/history?after=0", "/response"] {
        let url = format!("{shared}{suffix}");
        let response = client
            .get(&url)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let data = response.text().await.unwrap();
        for secret in [
            "SECRET_",
            "upstream_id",
            "audit_id",
            "grantee_user_id",
            "encrypted_content",
            "rate_limits",
        ] {
            assert!(!data.contains(secret), "{suffix}: {data}");
        }
        assert_eq!(
            client
                .get(&url)
                .bearer_auth(&tc)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert!(
        client
            .get(format!("{shared}/response"))
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
            .contains("visible live output")
    );
    let page = client
        .get(format!("{base}/api/shared-threads"))
        .bearer_auth(&tb)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], t.id);
    assert_eq!(
        client
            .get(format!("{base}/api/shared-threads/a/{}", private.id))
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    for action in ["inputs", "cancel", "continue", "compact", "title"] {
        let own_url = format!("{base}/api/threads/{}/{action}", t.id);
        assert_eq!(
            client
                .post(own_url)
                .bearer_auth(&tb)
                .json(&json!({"input":"forbidden"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND,
            "{action}"
        );
        assert!(
            !client
                .post(format!("{shared}/{action}"))
                .bearer_auth(&tb)
                .json(&json!({"input":"forbidden"}))
                .send()
                .await
                .unwrap()
                .status()
                .is_success(),
            "shared {action}"
        );
    }
    for method in [reqwest::Method::PATCH, reqwest::Method::DELETE] {
        assert_eq!(
            client
                .request(method.clone(), format!("{base}/api/threads/{}", t.id))
                .bearer_auth(&tb)
                .json(&json!({"title":"forbidden"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            client
                .request(method, &shared)
                .bearer_auth(&tb)
                .json(&json!({"title":"forbidden"}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
    for resource in ["grants", "history/window", "history", "response"] {
        assert_eq!(
            client
                .get(format!("{base}/api/threads/{}/{resource}", t.id))
                .bearer_auth(&tb)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    let key = client
        .post(format!("{base}/api/api-keys"))
        .bearer_auth(&tb)
        .json(&json!({"label":"integration"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let secret = key["secret"].as_str().unwrap();
    assert_eq!(
        client
            .get(format!("{base}/v1/threads/{}", t.id))
            .bearer_auth(secret)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client
            .get(&shared)
            .bearer_auth(secret)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .patch(format!("{shared}/visibility"))
            .bearer_auth(&tb)
            .json(&json!({"hidden":true}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    let page = client
        .get(format!("{base}/api/shared-threads"))
        .bearer_auth(&tb)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(page["items"], json!([]));
    assert_eq!(
        client
            .get(&shared)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .delete(&grant_url)
            .bearer_auth(&ta)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    for suffix in ["", "/history/window", "/history?after=0", "/response"] {
        assert_eq!(
            client
                .get(format!("{shared}{suffix}"))
                .bearer_auth(&tb)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        read_thread_for(&state, &a, t.id.clone())
            .await
            .unwrap()
            .status,
        "running"
    );
    client
        .put(&grant_url)
        .bearer_auth(&ta)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        client
            .get(&shared)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    client
        .delete(format!("{base}/api/threads/{}", t.id))
        .bearer_auth(&ta)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        client
            .get(&shared)
            .bearer_auth(&tb)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    let page = client
        .get(format!("{base}/api/shared-threads"))
        .bearer_auth(&tb)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(page["items"], json!([]));
    server.abort();
    issuer_task.abort();
}

#[test]
fn failed_schema_upgrade_rolls_back_and_remains_retryable() {
    let (_root, mut a, _, _) = fixture();
    a.execute_batch("DROP TRIGGER threads_revoke_shares; DROP TABLE thread_grants; DROP TABLE shared_threads; CREATE TABLE shared_threads(invalid_fixture TEXT); PRAGMA user_version=23;").unwrap();
    let record = insert_record(&a, THREAD, "input", json!({"content":"preserve bytes"}));
    assert!(ensure_user_schema(&mut a).is_err());
    assert_eq!(
        a.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        23
    );
    assert_eq!(
        a.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        a.query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='thread_grants'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert_eq!(load_history(&a, THREAD, 0).unwrap()[0].id, record);
    a.execute_batch("DROP TABLE shared_threads").unwrap();
    ensure_user_schema(&mut a).unwrap();
    assert_eq!(count(&a, "thread_grants"), 0);
    assert_eq!(load_history(&a, THREAD, 0).unwrap()[0].id, record);
}

#[tokio::test]
async fn supervisor_recovers_unsynced_grants_and_deletion_without_source_history() {
    let (_root, state) = test_state();
    let a = user_for_subject(&state, "recover-a").unwrap();
    let b = user_for_subject(&state, "recover-b").unwrap();
    let thread = create_test_thread(&state, &a).await;
    user_db(&state, &b, true, |_| Ok(())).await.unwrap();
    let id = thread.id.clone();
    user_db(&state, &a, false, move |c| {
        change_grant(c, "recover-a", &id, "recover-b", GrantAction::Grant)
    })
    .await
    .unwrap();
    assert_eq!(
        user_db(&state, &b, false, |c| Ok(count(c, "shared_threads")))
            .await
            .unwrap(),
        0
    );
    recovery::resume_running(&state).await.unwrap();
    let visible = list(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: b.clone(),
            bearer: String::new(),
        }),
        Query(ListQuery::default()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(visible.items.len(), 1);
    let id = thread.id.clone();
    user_db(&state, &a, false, move |c| {
        c.execute("DELETE FROM threads WHERE id=?", [id])?;
        Ok(())
    })
    .await
    .unwrap();
    // Even before the discovery tombstone has propagated, hydration denies it.
    let visible = list(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: b.clone(),
            bearer: String::new(),
        }),
        Query(ListQuery::default()),
    )
    .await
    .unwrap()
    .0;
    assert!(visible.items.is_empty());
    recovery::resume_running(&state).await.unwrap();
    assert_eq!(
        user_db(&state, &b, false, |c| Ok(discovery(
            c,
            ListQuery::default()
        )?
        .0
        .len()))
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        user_db(&state, &a, false, |c| Ok(count(c, "thread_grants")))
            .await
            .unwrap(),
        1
    );
}
