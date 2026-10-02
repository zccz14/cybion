use super::*;

const W: &str = "00000000-0000-4000-8000-000000000001";
fn fixture() -> (tempfile::TempDir, Connection, Connection, Connection) {
    let root = tempfile::tempdir().unwrap();
    let a = open_user(&root.path().join("a.sqlite3"), true).unwrap();
    let b = open_user(&root.path().join("b.sqlite3"), true).unwrap();
    let c = open_user(&root.path().join("c.sqlite3"), true).unwrap();
    a.execute("INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at) VALUES(?,'Device','fixture',1,'online',?)",params![W,now()]).unwrap();
    for db in [&a, &b, &c] {
        db.execute("INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES('thread','Private title','fixture','running',1,1)",[]).unwrap();
        db.execute("INSERT INTO history_records(id,thread_id,kind,payload,created_at) VALUES(1,'thread','input','{}',1)",[]).unwrap();
    }
    (root, a, b, c)
}
fn intent(c: &Connection, name: &str, call: &str) -> Intent {
    intent_for(c, 1, name, call)
}
fn intent_for(c: &Connection, input: i64, name: &str, call: &str) -> Intent {
    let payload = json!({"type":"function_call","call_id":call,"name":name,"arguments":json!({"worker_id":W,"command":"pwd","action":"screenshot"}).to_string()});
    let record = persist_history_record(
        c,
        HistoryRecordInsert {
            thread_id: "thread",
            kind: "response_output",
            payload: &payload,
            created_at: now(),
        },
    )
    .unwrap();
    bind_intent(c, record, "thread", input, &payload).unwrap();
    c.query_row(
        &format!("SELECT {INTENT_COLUMNS} FROM history_records WHERE id=?"),
        [record],
        intent_row,
    )
    .unwrap()
}
fn granted(a: &mut Connection) -> Grant {
    change_grant(a, "a", W, "b", false).unwrap();
    sync_grants(a, "a").unwrap();
    get_grant(a, W, "b").unwrap()
}
fn count(c: &Connection, table: &str) -> i64 {
    c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn grants_are_owner_only_revisioned_coalesced_and_tombstoned() {
    let (root, mut a, mut b, c) = fixture();
    assert!(change_grant(&mut a, "a", W, "a", false).is_err());
    assert!(change_grant(&mut a, "a", W, " a ", false).is_err());
    assert!(change_grant(&mut a, "a", W, "missing", false).is_err());
    assert!(!root.path().join("missing.sqlite3").exists());
    assert!(change_grant(&mut a, "a", W, "../escape", false).is_err());
    let first = granted(&mut a);
    assert_eq!(first.revision, 1);
    assert_eq!(first.synced_revision, 1);
    change_grant(&mut a, "a", W, "b", false).unwrap();
    assert_eq!(get_grant(&a, W, "b").unwrap().grant_id, first.grant_id);
    assert!(change_grant(&mut b, "b", W, "c", false).is_err());
    assert!(authorize(&a, W, "c", &first.grant_id).is_err());
    assert!(registered_workers(&c).unwrap().is_empty());
    let workers = registered_workers(&b).unwrap();
    assert_eq!(workers.len(), 1);
    assert_eq!(workers[0].access, "shared");
    assert_eq!(workers[0].owner_user_id, "a");
    assert!(
        responses_tools(!workers.is_empty(), true, true, true)
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "bash")
    );
    assert_eq!(count(&b, "workers"), 0);
    // B fails after A's authorization commit. Multiple changes coalesce.
    b.execute_batch("CREATE TRIGGER fail_sync BEFORE UPDATE ON shared_workers BEGIN SELECT RAISE(FAIL,'unavailable'); END;").unwrap();
    change_grant(&mut a, "a", W, "b", true).unwrap();
    sync_grants(&a, "a").unwrap();
    assert_eq!(get_grant(&a, W, "b").unwrap().synced_revision, 1);
    a.execute("UPDATE workers SET label='Renamed' WHERE id=?", [W])
        .unwrap();
    a.execute("UPDATE worker_grants SET revision=revision+1", [])
        .unwrap();
    change_grant(&mut a, "a", W, "b", false).unwrap();
    let second = get_grant(&a, W, "b").unwrap();
    assert_eq!(second.revision, 4);
    assert_ne!(first.grant_id, second.grant_id);
    b.execute_batch("DROP TRIGGER fail_sync;").unwrap();
    sync_grants(&a, "a").unwrap();
    let cached: (String, i64) = b
        .query_row("SELECT label,revision FROM shared_workers", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(cached, ("Renamed".into(), 4));
    change_grant(&mut a, "a", W, "b", true).unwrap();
    sync_grants(&a, "a").unwrap();
    assert!(registered_workers(&b).unwrap().is_empty());
    // A stale retry cannot undo a newer tombstone.
    a.execute(
        "UPDATE worker_grants SET revision=4,synced_revision=0,revoked_at=NULL",
        [],
    )
    .unwrap();
    sync_grants(&a, "a").unwrap();
    assert!(registered_workers(&b).unwrap().is_empty());
    assert_eq!(count(&a, "worker_grants"), 1);
    assert_eq!(count(&b, "shared_workers"), 1);
}

#[test]
fn owner_ledger_caller_history_idempotency_and_forged_discovery() {
    let (_root, mut a, b, c) = fixture();
    let grant = granted(&mut a);
    c.execute(
        "INSERT INTO shared_workers SELECT 'a',?,'forged',?,NULL,1,1,1",
        params![W, grant.grant_id],
    )
    .unwrap();
    let forged = intent(&c, "bash", "forged");
    assert!(enqueue_intent(&mut a, "c", &forged).is_err());
    let i = intent(&b, "bash", "call");
    enqueue_intent(&mut a, "b", &i).unwrap();
    enqueue_intent(&mut a, "b", &i).unwrap();
    assert_eq!(count(&a, "worker_calls"), 1);
    assert_eq!(count(&b, "worker_calls"), 0);
    let mut changed = i.clone();
    changed.payload["arguments"] = json!({"worker_id":W,"command":"other"}).to_string().into();
    assert!(enqueue_intent(&mut a, "b", &changed).is_err());
    assert!(save_foreign_result(&a, W, &i.id, "{}", "completed", None).is_err());
    let call = worker_protocol::claim(&mut a, W, None).unwrap().unwrap();
    assert_eq!(call.id, i.id);
    assert!(save_foreign_result(&a, "wrong", &i.id, "{}", "completed", None).is_ok_and(|v| !v));
    save_foreign_result(&a, W, &i.id, "{\"stdout\":\"ok\"}", "completed", None).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    // Simulate B commit / A acknowledgement loss.
    a.execute(
        "UPDATE worker_calls SET output_record_id=NULL WHERE id=?",
        [&i.id],
    )
    .unwrap();
    project_output(&a, "a", &i.id).unwrap();
    save_foreign_result(&a, W, &i.id, "{\"stdout\":\"ok\"}", "completed", None).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    assert!(save_foreign_result(&a, W, &i.id, "{}", "completed", None).is_err());
    assert_eq!(count(&a, "history_records"), 1);
    assert_eq!(count(&b, "history_records"), 3);
    assert_eq!(count(&c, "history_records"), 2);
    let page = audit_page(&a, "a", WorkerCallAuditQuery::default()).unwrap();
    assert_eq!(page.items[0].caller_user_id, "b");
    assert_eq!(page.items[0].thread_title, "");
    assert!(page.items[0].arguments.is_null());
    let stored: String = b
        .query_row(
            "SELECT payload FROM history_records WHERE worker_output_phase='primary'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!stored.contains("owner_user_id"));
    assert!(!stored.contains("grant_id"));
    assert!(
        screenshot_output_record_ids(&b, "thread")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn revoked_claim_and_old_delayed_intents_never_adopt_a_regrant() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let delayed = intent(&b, "bash", "delayed");
    let queued = intent(&b, "bash", "queued");
    enqueue_intent(&mut a, "b", &queued).unwrap();
    change_grant(&mut a, "a", W, "b", true).unwrap();
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
    change_grant(&mut a, "a", W, "b", false).unwrap();
    sync_grants(&a, "a").unwrap();
    assert!(enqueue_intent(&mut a, "b", &delayed).is_err());
    enqueue_intent(&mut a, "b", &queued).unwrap();
    assert_eq!(
        a.query_row(
            "SELECT status FROM worker_calls WHERE id=?",
            [&queued.id],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "cancelled"
    );
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
    project_output(&a, "a", &queued.id).unwrap();
    let output: String = b
        .query_row(
            "SELECT payload FROM history_records WHERE worker_output_phase='primary'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(output.contains("revoked"));
    assert_eq!(count(&a, "worker_calls"), 1);
}

#[test]
fn caller_cancel_delete_and_supersede_are_terminal() {
    for scenario in ["cancel", "delete", "supersede"] {
        let (_root, mut a, b, _) = fixture();
        granted(&mut a);
        let i = intent(&b, "bash", "call");
        enqueue_intent(&mut a, "b", &i).unwrap();
        match scenario {
            "cancel" => {
                b.execute("UPDATE threads SET status='idle'", []).unwrap();
            }
            "delete" => {
                b.execute("DELETE FROM threads", []).unwrap();
            }
            "supersede" => {
                b.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('thread','input','{}',2)",[]).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            worker_protocol::claim(&mut a, W, None).unwrap().is_none(),
            "{scenario}"
        );
        let status: String = a
            .query_row("SELECT status FROM worker_calls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "cancelled");
        if scenario == "delete" {
            project_output(&a, "a", &i.id).unwrap();
            assert_eq!(
                a.query_row("SELECT output_discarded FROM worker_calls", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }
}

#[test]
fn stale_sweep_cancels_orphaned_calls_and_keeps_dispatchable_ones() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let orphan = intent(&b, "bash", "orphan");
    enqueue_intent(&mut a, "b", &orphan).unwrap();
    worker_protocol::claim(&mut a, W, None).unwrap().unwrap();
    // A newer input supersedes the delivered call before its receipt arrives.
    b.execute(
        "INSERT INTO history_records(id,thread_id,kind,payload,created_at) VALUES(100,'thread','input','{}',2)",
        [],
    )
    .unwrap();
    let current = intent_for(&b, 100, "bash", "current");
    enqueue_intent(&mut a, "b", &current).unwrap();
    worker_protocol::claim(&mut a, W, None).unwrap().unwrap();
    let queued = intent_for(&b, 100, "bash", "queued");
    enqueue_intent(&mut a, "b", &queued).unwrap();
    cancel_stale(&a).unwrap();
    let status = |id: &str| -> (String, String) {
        a.query_row(
            "SELECT status,COALESCE(error,'') FROM worker_calls WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    };
    let (orphan_status, orphan_error) = status(&orphan.id);
    assert_eq!(orphan_status, "cancelled");
    assert!(orphan_error.contains("no longer active"), "{orphan_error}");
    assert_eq!(status(&current.id).0, "delivered");
    assert_eq!(status(&queued.id).0, "queued");
    // The cancelled call still projects its marker into the caller history.
    recover(&a, "a").unwrap();
    let marker: String = b
        .query_row(
            "SELECT payload FROM history_records WHERE worker_call_id=? AND worker_output_phase='primary'",
            [&orphan.id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(marker.contains("no longer active"), "{marker}");
}

#[test]
fn outputs_retry_when_caller_unavailable_and_late_results_are_separate() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "computer_use", "shot");
    enqueue_intent(&mut a, "b", &i).unwrap();
    worker_protocol::claim(&mut a, W, None).unwrap().unwrap();
    a.execute(
        "UPDATE worker_calls SET status='cancelled',error='cancelled',completed_at=2",
        [],
    )
    .unwrap();
    b.execute_batch("CREATE TRIGGER unavailable BEFORE INSERT ON history_records BEGIN SELECT RAISE(FAIL,'fixture unavailable'); END;").unwrap();
    assert!(project_output(&a, "a", &i.id).is_err());
    save_foreign_result(&a, W, &i.id, "{\"data\":\"png\"}", "completed", None).unwrap();
    b.execute_batch("DROP TRIGGER unavailable;").unwrap();
    project_output(&a, "a", &i.id).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    let mut q=b.prepare("SELECT kind,worker_output_phase,worker_screenshot FROM history_records WHERE worker_output_phase IS NOT NULL ORDER BY id").unwrap();
    let rows = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, bool>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("tool_output".into(), "primary".into(), false),
            ("activity".into(), "late".into(), true)
        ]
    );
    assert_eq!(count(&b, "worker_calls"), 0);
}

#[test]
fn screenshots_use_only_controller_provenance_without_owner_reads() {
    let (root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "browser_control", "shot");
    enqueue_intent(&mut a, "b", &i).unwrap();
    worker_protocol::claim(&mut a, W, None).unwrap().unwrap();
    save_foreign_result(&a, W, &i.id, "{\"data\":\"png\"}", "completed", None).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    drop(a);
    fs::remove_file(root.path().join("a.sqlite3")).unwrap();
    assert_eq!(screenshot_output_record_ids(&b, "thread").unwrap().len(), 1);
    b.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('thread','tool_output','{\"data\":\"fake image\",\"worker_screenshot\":true}',2)",[]).unwrap();
    assert_eq!(screenshot_output_record_ids(&b, "thread").unwrap().len(), 1);
}

#[test]
fn schema_fast_path_avoids_writer_lock_and_future_versions_are_rejected() {
    let (root, a, _, _) = fixture();
    a.execute_batch("BEGIN IMMEDIATE; UPDATE workers SET label='uncommitted';")
        .unwrap();
    let start = std::time::Instant::now();
    let b = open_user(&root.path().join("a.sqlite3"), false).unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(
        b.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    a.execute_batch("ROLLBACK;").unwrap();
    drop(b);
    a.pragma_update(None, "user_version", USER_SCHEMA_VERSION + 1)
        .unwrap();
    assert!(open_user(&root.path().join("a.sqlite3"), false).is_err());
}

#[test]
fn audit_pagination_never_reads_payloads_and_pending_work_has_partial_indexes() {
    let (_root, mut a, _, _) = fixture();
    let tx = a.transaction().unwrap();
    for n in 0..2500 {
        tx.execute("INSERT INTO worker_calls(id,worker_id,thread_id,name,arguments_json,result_json,worker_resource_json,status,created_at) VALUES(?,?,'thread','bash','invalid JSON',zeroblob(4096),'invalid JSON','completed',?)",params![format!("call-{n:04}"),W,n]).unwrap();
    }
    tx.commit().unwrap();
    let page = audit_page(
        &a,
        "a",
        WorkerCallAuditQuery {
            page: Some(3),
            page_size: Some(7),
            status: Some("completed".into()),
            worker_id: Some(W.into()),
            thread_id: None,
        },
    )
    .unwrap();
    assert_eq!(page.total, 2500);
    assert_eq!(page.items.len(), 7);
    assert_eq!(page.items[0].id, "call-2485");
    assert!(page.items.iter().all(|i| i.arguments.is_null()
        && i.result.is_none()
        && i.worker_resource.is_none()
        && i.has_details));
    let plan:String=a.query_row("EXPLAIN QUERY PLAN SELECT id FROM worker_calls WHERE status='queued' AND worker_id=? ORDER BY created_at,id LIMIT 1",[W],|r|r.get(3)).unwrap();
    assert!(plan.contains("INDEX"));
    let sql: String = a
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE name='worker_calls_pending_output'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(sql.contains("WHERE caller_user_id IS NOT NULL"));
    let tables:Vec<String>=a.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE '%worker%' OR name LIKE '%outbox%' OR name LIKE '%inbox%') ORDER BY name").unwrap().query_map([],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(
        tables,
        vec![
            "shared_workers",
            "worker_calls",
            "worker_checks",
            "worker_grants",
            "workers"
        ]
    );
}

#[test]
fn restart_unknown_outcome_routes_to_caller_and_replay_checks_grant_cycle() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let old = Uuid::new_v4().to_string();
    let new = Uuid::new_v4().to_string();
    worker_protocol::register(&mut a, W, Some(&old), Some("0.2.0")).unwrap();
    let i = intent(&b, "bash", "restart");
    enqueue_intent(&mut a, "b", &i).unwrap();
    worker_protocol::claim(&mut a, W, Some(&old))
        .unwrap()
        .unwrap();
    assert!(
        worker_protocol::replay(&a, W, Some(&old), &i.id)
            .unwrap()
            .is_some()
    );
    worker_protocol::register(&mut a, W, Some(&new), Some("0.2.0")).unwrap();
    assert!(
        worker_protocol::claim(&mut a, W, Some(&new))
            .unwrap()
            .is_none()
    );
    project_output(&a, "a", &i.id).unwrap();
    let raw: String = b
        .query_row(
            "SELECT payload FROM history_records WHERE worker_output_phase='primary'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let output: Value = serde_json::from_str(&raw).unwrap();
    let result: Value = serde_json::from_str(output["output"].as_str().unwrap()).unwrap();
    assert_eq!(result["execution_outcome"], "unknown");
    assert_eq!(result["code"], "worker_restarted");
    let j = intent(&b, "bash", "replay");
    enqueue_intent(&mut a, "b", &j).unwrap();
    worker_protocol::claim(&mut a, W, Some(&new))
        .unwrap()
        .unwrap();
    change_grant(&mut a, "a", W, "b", true).unwrap();
    change_grant(&mut a, "a", W, "b", false).unwrap();
    assert!(
        worker_protocol::replay(&a, W, Some(&new), &j.id)
            .unwrap()
            .is_none()
    );
    assert_eq!(count(&a, "history_records"), 1);
}

#[test]
fn frozen_schema_21_preserves_ids_results_receipts_and_removes_foreign_history_fks() {
    let mut c = Connection::open_in_memory().unwrap();
    c.execute_batch(THREAD_SCHEMA).unwrap();
    // Frozen deployed Worker ledger, independent of migration's replacement DDL.
    c.execute_batch(
        r#"CREATE TABLE worker_calls (
      id TEXT PRIMARY KEY, responses_call_id TEXT NOT NULL DEFAULT '',
      responses_output_type TEXT NOT NULL DEFAULT 'function_call_output',
      worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      input_record_id INTEGER REFERENCES history_records(id) ON DELETE SET NULL,
      name TEXT NOT NULL, arguments_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','delivered','completed','failed')),
      result_json TEXT, created_at INTEGER NOT NULL, started_at INTEGER,
      worker_label TEXT,worker_hostname TEXT,worker_version TEXT,worker_resource_json TEXT,
      output_record_id INTEGER REFERENCES history_records(id) ON DELETE SET NULL,
      completed_at INTEGER,error TEXT,worker_boot_id TEXT,received_at INTEGER);
      CREATE INDEX fixture_ledger_index ON worker_calls(received_at);
    "#,
    )
    .unwrap();
    c.execute_batch(USER_SCHEMA).unwrap();
    c.execute_batch(r#"INSERT INTO workers(id,label,token_hash,created_at) VALUES('worker','kept','fixture',1);
      INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES('thread','kept','fixture','idle',1,1);
      INSERT INTO history_records(id,thread_id,kind,payload,created_at) VALUES(7,'thread','input','{}',1),(19,'thread','tool_output','{ "raw": 1 }',2);
      INSERT INTO worker_calls(id,responses_call_id,worker_id,thread_id,input_record_id,name,arguments_json,status,result_json,created_at,started_at,output_record_id,completed_at,worker_boot_id,received_at) VALUES('call','provider','worker','thread',7,'bash','{ "command": "pwd" }','completed','{ "stdout": "keep bytes" }',1,2,19,3,'boot',4);
      PRAGMA user_version=21;"#).unwrap();
    let before:String=c.query_row("SELECT json_array(id,responses_call_id,worker_id,thread_id,input_record_id,name,arguments_json,status,result_json,created_at,started_at,output_record_id,completed_at,worker_boot_id,received_at) FROM worker_calls",[],|r|r.get(0)).unwrap();
    ensure_user_schema(&mut c).unwrap();
    let after:String=c.query_row("SELECT json_array(id,responses_call_id,worker_id,thread_id,input_record_id,name,arguments_json,status,result_json,created_at,started_at,output_record_id,completed_at,worker_boot_id,received_at) FROM worker_calls",[],|r|r.get(0)).unwrap();
    assert_eq!(before, after);
    check_user_foreign_keys(&c).unwrap();
    assert_eq!(
        c.query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let fks: Vec<String> = c
        .prepare("PRAGMA foreign_key_list(worker_calls)")
        .unwrap()
        .query_map([], |r| r.get(2))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(fks, vec!["workers"]);
    c.execute("DELETE FROM threads", []).unwrap();
    assert_eq!(count(&c, "worker_calls"), 1);
    assert!(
        c.query_row(
            "SELECT sql FROM sqlite_schema WHERE name='fixture_ledger_index'",
            [],
            |r| r.get::<_, String>(0)
        )
        .is_ok()
    );
    c.execute("INSERT INTO worker_calls(id,worker_id,thread_id,input_record_id,output_record_id,caller_user_id,name,arguments_json,status,created_at) VALUES('foreign','worker','absent-in-owner',7000,9000,'b','bash','{}','completed',1)",[]).unwrap();
    check_user_foreign_keys(&c).unwrap();
}

#[tokio::test]
async fn committed_stream_dispatch_management_and_callback_unavailable_recipient() {
    use crate::cloud::tests::{create_test_thread, test_state};
    let (_root, state) = test_state();
    let a = user_from_id(&state, "a".into()).unwrap();
    let b = user_from_id(&state, "b".into()).unwrap();
    let c = user_from_id(&state, "c".into()).unwrap();
    let thread = create_test_thread(&state, &b).await;
    let _ = open_user(&a.path, true).unwrap();
    let _ = open_user(&c.path, true).unwrap();
    let input = user_db(&state, &b, false, {
        let thread = thread.id.clone();
        move |db| {
            db.execute("UPDATE threads SET status='running' WHERE id=?", [&thread])?;
            persist_history_record(
                db,
                HistoryRecordInsert {
                    thread_id: &thread,
                    kind: "input",
                    payload: &json!({"role":"user","content":"work"}),
                    created_at: now(),
                },
            )
        }
    })
    .await
    .unwrap();
    user_db(&state,&a,false,|db|{db.execute("INSERT INTO workers(id,label,token_hash,created_at,status,last_seen_at,boot_id,version) VALUES(?,'Device','fixture',1,'online',?,'boot','0.2.0')",params![W,now()])?;change_grant(db,"a",W,"b",false)?;sync_grants(db,"a")}).await.unwrap();
    let identity = || {
        axum::Extension(BrowserIdentity {
            user: b.clone(),
            bearer: "fixture".into(),
        })
    };
    let view = read_worker(State(state.clone()), identity(), AxumPath(W.into()))
        .await
        .unwrap()
        .0;
    assert_eq!(view.access, "shared");
    assert!(!view.can_upgrade);
    assert!(view.resource.is_none());
    assert!(
        list_grants(State(state.clone()), identity(), AxumPath(W.into()))
            .await
            .is_err()
    );
    assert!(
        grant(
            State(state.clone()),
            identity(),
            AxumPath((W.into(), "c".into()))
        )
        .await
        .is_err()
    );
    assert!(
        update_worker(
            State(state.clone()),
            identity(),
            AxumPath(W.into()),
            Json(UpdateWorkerInput {
                label: "bad".into()
            })
        )
        .await
        .is_err()
    );
    assert!(
        worker_protocol::request_upgrade(State(state.clone()), identity(), AxumPath(W.into()))
            .await
            .is_err()
    );
    assert!(
        worker_onboarding::check_read(State(state.clone()), identity(), AxumPath(W.into()))
            .await
            .is_err()
    );
    assert!(
        delete_worker(State(state.clone()), identity(), AxumPath(W.into()))
            .await
            .is_err()
    );
    let item=ResponseItem::from_value(json!({"type":"function_call","call_id":"shared-stream","name":"bash","arguments":json!({"worker_id":W,"command":"pwd"}).to_string()})).unwrap();
    let ids = append_response_output_items(&state, &b, &thread, input, std::slice::from_ref(&item))
        .await
        .unwrap();
    assert_eq!(ids.len(), 1);
    let id = user_db(&state, &a, false, |db| {
        Ok(worker_protocol::claim(db, W, Some("boot"))?.unwrap().id)
    })
    .await
    .unwrap();
    // Repeated stream output reuses the durable origin and does not enqueue twice.
    assert_eq!(
        append_response_output_items(&state, &b, &thread, input, &[item])
            .await
            .unwrap(),
        ids
    );
    let bdb = open_user(&b.path, false).unwrap();
    bdb.execute_batch("CREATE TRIGGER reject_output BEFORE INSERT ON history_records BEGIN SELECT RAISE(FAIL,'unavailable'); END;").unwrap();
    let callback = || WorkerResultInput {
        result: json!({"stdout":"ok"}),
        failed: false,
        error: None,
    };
    let result = worker_result(
        State(state.clone()),
        AxumPath(("a".into(), W.into(), id.clone())),
        axum::Extension(a.clone()),
        Json(callback()),
    )
    .await
    .unwrap();
    assert_eq!(result.0["ok"], true);
    let adb = open_user(&a.path, false).unwrap();
    assert_eq!(count(&adb, "worker_calls"), 1);
    assert_eq!(count(&adb, "threads"), 0);
    assert_eq!(count(&bdb, "worker_calls"), 0);
    bdb.execute_batch("DROP TRIGGER reject_output;").unwrap();
    let _ = worker_result(
        State(state.clone()),
        AxumPath(("a".into(), W.into(), id.clone())),
        axum::Extension(a.clone()),
        Json(callback()),
    )
    .await
    .unwrap();
    assert_eq!(
        bdb.query_row(
            "SELECT COUNT(*) FROM history_records WHERE worker_output_phase='primary'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(call_owner(&state, &b, &id).await.unwrap().id, "a");
    assert!(
        call_detail(State(state.clone()), identity(), AxumPath(id.clone()))
            .await
            .is_err()
    );
    let detail = call_detail(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: a.clone(),
            bearer: "fixture".into(),
        }),
        AxumPath(id),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(detail.caller_user_id, "b");
    assert_eq!(detail.arguments["command"], "pwd");
    delete_worker(
        State(state.clone()),
        axum::Extension(BrowserIdentity {
            user: a.clone(),
            bearer: "fixture".into(),
        }),
        AxumPath(W.into()),
    )
    .await
    .unwrap();
    assert_eq!(count(&adb, "worker_calls"), 1);
    assert!(registered_workers(&bdb).unwrap().is_empty());
}

#[test]
fn recovery_batches_rotate_failed_recipients_without_scanning_payloads() {
    let (_root, mut a, b, _) = fixture();
    // Pending unavailable relationships must not permanently starve a later one.
    for n in 0..40 {
        a.execute("INSERT INTO worker_grants(worker_id,grantee_user_id,grant_id,revision,created_at,updated_at) VALUES(?,?,?,1,1,1)",params![W,format!("absent-{n:02}"),format!("g-{n}")]).unwrap();
    }
    change_grant(&mut a, "a", W, "b", false).unwrap();
    sync_grants(&a, "a").unwrap();
    assert_eq!(count(&b, "shared_workers"), 0);
    let attempted: i64 = a
        .query_row(
            "SELECT COUNT(*) FROM worker_grants WHERE sync_attempted_at>0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(attempted, BATCH);
    sync_grants(&a, "a").unwrap();
    assert_eq!(count(&b, "shared_workers"), 1);
    // Exact pending predicate is indexable without fetching result bodies.
    let plans:Vec<String>=a.prepare("EXPLAIN QUERY PLAN SELECT id FROM worker_calls INDEXED BY worker_calls_pending_output WHERE caller_user_id IS NOT NULL AND status IN ('completed','failed','cancelled') AND ((output_record_id IS NULL AND output_discarded=0) OR (late_result=1 AND result_json IS NOT NULL AND late_output_record_id IS NULL AND late_output_discarded=0)) ORDER BY delivery_attempted_at,created_at,id LIMIT 32").unwrap().query_map([],|r|r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert!(
        plans
            .iter()
            .any(|p| p.contains("worker_calls_pending_output")),
        "{plans:?}"
    );
}

#[test]
fn owner_thread_deletion_does_not_touch_foreign_call_or_recipient_history() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "bash", "call");
    enqueue_intent(&mut a, "b", &i).unwrap();
    a.execute("DELETE FROM threads WHERE id='thread'", [])
        .unwrap();
    assert_eq!(count(&a, "worker_calls"), 1);
    assert_eq!(count(&b, "history_records"), 2);
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        i.id
    );
    save_foreign_result(&a, W, &i.id, "{}", "completed", None).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    assert_eq!(count(&a, "history_records"), 0);
    assert_eq!(count(&b, "history_records"), 3);
}

#[test]
fn startup_recovery_isolates_an_unavailable_user() {
    let root = tempfile::tempdir().unwrap();
    let users = root.path().join("users");
    fs::create_dir(&users).unwrap();
    fs::write(users.join("unavailable.sqlite3"), b"fixture invalid SQLite").unwrap();
    let b = open_user(&users.join("b.sqlite3"), true).unwrap();
    b.execute("INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES('thread','fixture','fixture','running',1,1)",[]).unwrap();
    b.execute("INSERT INTO history_records(thread_id,kind,payload,created_at) VALUES('thread','input','{}',1)",[]).unwrap();
    recover_interrupted_requests(root.path()).unwrap();
    assert_eq!(count(&b, "history_records"), 2);
    assert_eq!(
        b.query_row("SELECT status FROM threads", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "running"
    );
}

#[tokio::test]
async fn owned_call_callbacks_require_actual_delivery_too() {
    let (root, mut a, _, _) = fixture();
    let (_state_root, state) = crate::cloud::tests::test_state();
    let user = User {
        id: "a".into(),
        path: root.path().join("a.sqlite3"),
    };
    let id = enqueue_worker_call_tx(
        &a,
        W,
        "thread",
        1,
        "call",
        "function_call_output",
        "bash",
        &json!({"command":"pwd"}),
    )
    .unwrap();
    let callback = || WorkerResultInput {
        result: json!({"stdout":"ok"}),
        failed: false,
        error: None,
    };
    assert_eq!(
        worker_result(
            State(state.clone()),
            AxumPath(("a".into(), W.into(), id.clone())),
            axum::Extension(user.clone()),
            Json(callback())
        )
        .await
        .unwrap_err()
        .status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        id
    );
    let _ = worker_result(
        State(state.clone()),
        AxumPath(("a".into(), W.into(), id)),
        axum::Extension(user),
        Json(callback()),
    )
    .await
    .unwrap();
    assert_eq!(count(&a, "history_records"), 2);
    assert_eq!(count(&a, "worker_calls"), 1);
}

#[test]
fn unavailable_caller_defers_without_blocking_others_and_resumes_original_origin() {
    let (root, mut a, b, c) = fixture();
    granted(&mut a);
    change_grant(&mut a, "a", W, "c", false).unwrap();
    sync_grants(&a, "a").unwrap();
    let original = intent(&b, "bash", "original");
    enqueue_intent(&mut a, "b", &original).unwrap();
    a.execute("UPDATE worker_calls SET created_at=?", [now() - 20])
        .unwrap();
    let other = intent(&c, "bash", "other");
    enqueue_intent(&mut a, "c", &other).unwrap();
    drop(b);
    fs::rename(
        root.path().join("b.sqlite3"),
        root.path().join("b.unavailable"),
    )
    .unwrap();
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        other.id
    );
    let row:(String,Option<String>,Option<i64>,Option<String>,i64)=a.query_row("SELECT status,error,completed_at,grant_id,dispatch_retry_at FROM worker_calls WHERE id=?",[&original.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        (row.0, row.1, row.2, row.3),
        ("queued".into(), None, None, original.grant.clone())
    );
    assert!(row.4 > now());
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
    assert!(!root.path().join("b.sqlite3").exists());
    fs::rename(
        root.path().join("b.unavailable"),
        root.path().join("b.sqlite3"),
    )
    .unwrap();
    // Advance the persisted deadline without sleeping. New arrivals after this
    // deadline must not indefinitely outrank the due retry (whose marker > 0).
    a.execute(
        "UPDATE worker_calls SET dispatch_retry_at=? WHERE id=?",
        params![now() - 2, original.id],
    )
    .unwrap();
    for n in 0..16 {
        let i = intent(&c, "bash", &format!("arrival-{n}"));
        enqueue_intent(&mut a, "c", &i).unwrap();
    }
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        original.id
    );
    let same:(String,Option<String>,String)=a.query_row("SELECT id,grant_id,caller_user_id FROM worker_calls WHERE responses_call_id='original'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(same, (original.id.clone(), original.grant, "b".into()));
    assert_ne!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        original.id
    );
    let plan:Vec<String>=a.prepare("EXPLAIN QUERY PLAN SELECT id FROM worker_calls INDEXED BY worker_calls_queued WHERE worker_id=? AND status='queued' AND MAX(created_at,dispatch_retry_at)<=? ORDER BY MAX(created_at,dispatch_retry_at),created_at,id LIMIT 1").unwrap().query_map(params![W,now()],|r|r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert!(plan.iter().any(|p| p.contains("worker_calls_queued")));
    assert!(!plan.iter().any(|p| p.contains("TEMP B-TREE")));
}

#[test]
fn live_connection_retains_deferred_replay_and_alternates_with_other_callers() {
    let (root, mut a, b, c) = fixture();
    granted(&mut a);
    change_grant(&mut a, "a", W, "c", false).unwrap();
    sync_grants(&a, "a").unwrap();
    let boot = Uuid::new_v4().to_string();
    worker_protocol::register(&mut a, W, Some(&boot), None).unwrap();
    let original = intent(&b, "bash", "original");
    enqueue_intent(&mut a, "b", &original).unwrap();
    assert_eq!(
        worker_protocol::claim(&mut a, W, Some(&boot))
            .unwrap()
            .unwrap()
            .id,
        original.id
    );
    let mut replay = worker_protocol::register(&mut a, W, Some(&boot), None).unwrap();
    assert_eq!(replay.len(), 1);
    let other = intent(&c, "bash", "other");
    enqueue_intent(&mut a, "c", &other).unwrap();
    drop(b);
    fs::rename(
        root.path().join("b.sqlite3"),
        root.path().join("b.unavailable"),
    )
    .unwrap();
    assert_eq!(
        worker_protocol::next_call(&mut a, W, Some(&boot), &mut replay, true)
            .unwrap()
            .unwrap()
            .id,
        other.id
    );
    assert_eq!(replay.front(), Some(&original.id));
    let status: String = a
        .query_row(
            "SELECT status FROM worker_calls WHERE id=?",
            [&original.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "delivered");
    assert!(
        worker_protocol::next_call(&mut a, W, Some(&boot), &mut replay, false)
            .unwrap()
            .is_none()
    );
    assert_eq!(replay.len(), 1);
    fs::rename(
        root.path().join("b.unavailable"),
        root.path().join("b.sqlite3"),
    )
    .unwrap();
    a.execute(
        "UPDATE worker_calls SET dispatch_retry_at=0 WHERE id=?",
        [&original.id],
    )
    .unwrap();
    let newer = intent(&c, "bash", "newer");
    enqueue_intent(&mut a, "c", &newer).unwrap();
    assert_eq!(
        worker_protocol::next_call(&mut a, W, Some(&boot), &mut replay, false)
            .unwrap()
            .unwrap()
            .id,
        newer.id
    );
    assert_eq!(
        worker_protocol::next_call(&mut a, W, Some(&boot), &mut replay, true)
            .unwrap()
            .unwrap()
            .id,
        original.id
    );
    assert!(replay.is_empty());
    assert!(
        worker_protocol::next_call(&mut a, W, Some(&boot), &mut replay, false)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        a.query_row(
            "SELECT grant_id FROM worker_calls WHERE id=?",
            [&original.id],
            |r| r.get::<_, Option<String>>(0)
        )
        .unwrap(),
        original.grant
    );
}

#[test]
fn caller_schema_and_sqlite_errors_defer_but_owner_errors_propagate() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "bash", "original");
    enqueue_intent(&mut a, "b", &i).unwrap();
    b.pragma_update(None, "user_version", USER_SCHEMA_VERSION + 1)
        .unwrap();
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
    assert_eq!(
        a.query_row("SELECT status FROM worker_calls", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "queued"
    );
    b.pragma_update(None, "user_version", USER_SCHEMA_VERSION)
        .unwrap();
    a.execute("UPDATE worker_calls SET dispatch_retry_at=0", [])
        .unwrap();
    b.execute_batch("ALTER TABLE history_records RENAME TO unavailable_history;")
        .unwrap();
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
    assert_eq!(
        a.query_row("SELECT status FROM worker_calls", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "queued"
    );
    b.execute_batch("ALTER TABLE unavailable_history RENAME TO history_records;")
        .unwrap();
    a.execute("UPDATE worker_calls SET dispatch_retry_at=0", [])
        .unwrap();
    a.execute_batch("ALTER TABLE worker_grants RENAME TO unavailable_grants;")
        .unwrap();
    assert!(worker_protocol::claim(&mut a, W, None).is_err());
    assert_eq!(
        a.query_row("SELECT status FROM worker_calls", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "queued"
    );
    a.execute_batch("ALTER TABLE unavailable_grants RENAME TO worker_grants;")
        .unwrap();
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        i.id
    );
}

#[test]
fn thread_filtered_audit_count_and_pages_exclude_colliding_foreign_threads() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let foreign = intent(&b, "bash", "foreign");
    enqueue_intent(&mut a, "b", &foreign).unwrap();
    for id in ["local-1", "local-2"] {
        enqueue_worker_call_tx(
            &a,
            W,
            "thread",
            1,
            id,
            "function_call_output",
            "bash",
            &json!({"command":"pwd"}),
        )
        .unwrap();
    }
    let all = audit_page(&a, "a", WorkerCallAuditQuery::default()).unwrap();
    assert_eq!(all.total, 3);
    let foreign = all.items.iter().find(|i| i.caller_user_id == "b").unwrap();
    assert!(foreign.thread_title.is_empty());
    let mut local_ids = std::collections::HashSet::new();
    for page in 1..=3 {
        let result = audit_page(
            &a,
            "a",
            WorkerCallAuditQuery {
                thread_id: Some("thread".into()),
                page: Some(page),
                page_size: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.items.len(), usize::from(page < 3));
        for row in result.items {
            assert_eq!(row.caller_user_id, "a");
            assert_eq!(row.thread_title, "Private title");
            local_ids.insert(row.id);
        }
    }
    assert_eq!(local_ids.len(), 2);
}

#[tokio::test]
async fn audit_error_excerpt_bounds_explicit_and_fallback_failure_without_truncating_detail() {
    let (root, mut a, _, _) = fixture();
    let (_state_root, state) = crate::cloud::tests::test_state();
    let user = User {
        id: "a".into(),
        path: root.path().join("a.sqlite3"),
    };
    for explicit in [true, false] {
        let long = "x".repeat(3 * 1024 * 1024);
        let result = if explicit {
            json!({"failed":true})
        } else {
            json!({"stderr":long})
        };
        let error = if explicit { Some(long) } else { None };
        let expected_error = error.clone().unwrap_or_else(|| result.to_string());
        let id = enqueue_worker_call_tx(
            &a,
            W,
            "thread",
            1,
            if explicit { "explicit" } else { "fallback" },
            "function_call_output",
            "bash",
            &json!({"command":"pwd"}),
        )
        .unwrap();
        assert_eq!(
            worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
            id
        );
        let _ = worker_result(
            State(state.clone()),
            AxumPath(("a".into(), W.into(), id.clone())),
            axum::Extension(user.clone()),
            Json(WorkerResultInput {
                result: result.clone(),
                failed: true,
                error,
            }),
        )
        .await
        .unwrap();
        let detail = a
            .query_row(
                &format!("{} WHERE c.id=?2", audit_select(true)),
                params!["a", id],
                audit_row,
            )
            .unwrap();
        assert_eq!(detail.error.as_deref(), Some(expected_error.as_str()));
        assert_eq!(detail.result, Some(result));
    }
    let page = audit_page(&a, "a", WorkerCallAuditQuery::default()).unwrap();
    assert_eq!(page.total, 2);
    for row in &page.items {
        assert_eq!(row.error.as_ref().unwrap().chars().count(), 1024);
        assert!(row.result.is_none());
        assert!(row.arguments.is_null());
    }
    assert!(serde_json::to_vec(&page).unwrap().len() < 5000);
}

#[test]
fn current_schema_reopen_preserves_pending_origin_and_retry_marker() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "bash", "original");
    enqueue_intent(&mut a, "b", &i).unwrap();
    ensure_user_schema(&mut a).unwrap();
    let row: (String, Option<String>, String, i64) = a
        .query_row(
            "SELECT id,grant_id,status,dispatch_retry_at FROM worker_calls",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, (i.id, i.grant, "queued".into(), 0));
    check_user_foreign_keys(&a).unwrap();
}

#[test]
fn worker_statistics_do_not_associate_foreign_calls_with_colliding_owner_runs() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let foreign = intent(&b, "bash", "foreign");
    enqueue_intent(&mut a, "b", &foreign).unwrap();
    a.execute(
        "UPDATE worker_calls SET status='completed',created_at=1,completed_at=100 WHERE id=?",
        [&foreign.id],
    )
    .unwrap();
    a.execute("INSERT INTO reasoning_audits(thread_id,input_record_id,model,request_kind,status,started_at,finished_at) VALUES('thread',1,'owner-model','inference','completed',1,2)",[]).unwrap();
    let all = load_insights(&a, "all".into(), None, None, None, None).unwrap();
    assert_eq!(all.worker.calls, 1);
    let thread = load_insights(&a, "all".into(), None, Some("thread".into()), None, None).unwrap();
    assert_eq!(thread.worker.calls, 0);
    assert_eq!(thread.attribution.worker_seconds, 0);
    let model = load_insights(
        &a,
        "all".into(),
        None,
        None,
        Some("owner-model".into()),
        None,
    )
    .unwrap();
    assert_eq!(model.worker.calls, 0);
    let inference =
        load_insights(&a, "all".into(), None, None, None, Some("inference".into())).unwrap();
    assert_eq!(inference.worker.calls, 0);
    let own = enqueue_worker_call_tx(
        &a,
        W,
        "thread",
        1,
        "own",
        "function_call_output",
        "bash",
        &json!({"command":"pwd"}),
    )
    .unwrap();
    a.execute(
        "UPDATE worker_calls SET status='completed',created_at=3,completed_at=5 WHERE id=?",
        [own],
    )
    .unwrap();
    let thread = load_insights(&a, "all".into(), None, Some("thread".into()), None, None).unwrap();
    assert_eq!(thread.worker.calls, 1);
    assert_eq!(thread.attribution.worker_seconds, 2);
}

#[test]
fn accepted_result_remains_recoverable_after_revoke_and_offline_without_reexecution() {
    let (_root, mut a, b, _) = fixture();
    granted(&mut a);
    let i = intent(&b, "bash", "completed-before-revoke");
    enqueue_intent(&mut a, "b", &i).unwrap();
    assert_eq!(
        worker_protocol::claim(&mut a, W, None).unwrap().unwrap().id,
        i.id
    );
    save_foreign_result(
        &a,
        W,
        &i.id,
        "{\"stdout\":\"completed-once\"}",
        "completed",
        None,
    )
    .unwrap();
    change_grant(&mut a, "a", W, "b", true).unwrap();
    a.execute("UPDATE workers SET status='offline' WHERE id=?", [W])
        .unwrap();
    // Recover before A's asynchronous output projector has run.
    enqueue_intent(&mut a, "b", &i).unwrap();
    assert_eq!(count(&a, "worker_calls"), 1);
    assert_eq!(
        a.query_row("SELECT status FROM worker_calls WHERE id=?", [&i.id], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "completed"
    );
    assert!(enqueue_intent(&mut a, "c", &i).is_err());
    let mut changed = i.clone();
    changed.payload["arguments"] = json!({"worker_id":W,"command":"different"})
        .to_string()
        .into();
    assert!(enqueue_intent(&mut a, "b", &changed).is_err());
    project_output(&a, "a", &i.id).unwrap();
    project_output(&a, "a", &i.id).unwrap();
    let outputs: Vec<String> = b
        .prepare("SELECT payload FROM history_records WHERE worker_output_phase='primary'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(outputs.len(), 1);
    assert!(outputs[0].contains("completed-once"));
    assert!(!outputs[0].contains("revoked"));
    assert!(worker_protocol::claim(&mut a, W, None).unwrap().is_none());
}
