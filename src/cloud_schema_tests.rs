use super::tests::{create_test_thread, insert_record, test_state};
use super::*;

// A frozen fixture of the deployed schema, independent of new-database DDL.
pub(super) const LEGACY_HISTORY_SCHEMA: &str = r#"
CREATE TABLE history_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  request_input_id INTEGER REFERENCES history_records(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'input' CHECK(kind IN ('input','response_output','tool_output','checkpoint','activity')),
  payload TEXT NOT NULL DEFAULT '{}',
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX history_records_request_input ON history_records(request_input_id,id);
"#;

fn legacy_database(version: i64) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(THREAD_SCHEMA).unwrap();
    connection.execute_batch(LEGACY_HISTORY_SCHEMA).unwrap();
    connection.execute_batch(USER_SCHEMA).unwrap();
    connection.execute_batch(USER_HISTORY_INDEXES).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    connection
        .pragma_update(None, "user_version", version)
        .unwrap();
    connection.execute_batch(
        "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES
         ('a','Alpha','model','idle',1,1),('b','Beta','model','idle',1,1);
         INSERT INTO history_records(id,thread_id,request_input_id,role,content,kind,payload,visible,created_at) VALUES
         (7,'a',NULL,'user','obsolete input','input',' { \"role\":\"user\", \"content\":\"保留原文\" } ',1,101),
         (12,'a',7,'tool','obsolete output','tool_output','{\"type\":\"function_call_output\",\"call_id\":\"call\",\"output\":\"result\"}',0,102),
         (16,'a',7,'system','obsolete activity','activity','not JSON: 数据',1,103),
         (19,'a',NULL,'system','obsolete checkpoint','checkpoint','{\"role\":\"developer\",\"content\":\"checkpoint\"}',0,104),
         (22,'b',NULL,'assistant','obsolete message','response_output','{ \"a\":1, \"a\":2 }',1,105),
         (1000,'b',NULL,'system','deleted','activity','{}',0,106);
         DELETE FROM history_records WHERE id=1000;
         INSERT INTO workers(id,label,token_hash,created_at) VALUES('worker','Worker','hash',1);
         INSERT INTO worker_calls(id,worker_id,thread_id,input_record_id,output_record_id,name,arguments_json,status,created_at)
           VALUES('call','worker','a',7,12,'bash','{}','completed',1);
         INSERT INTO reasoning_audits(id,input_record_id,thread_id,model,status,started_at)
           VALUES(21,7,'a','model','completed',1);
         INSERT INTO response_states(audit_id,snapshot) VALUES(21,'{}');",
    ).unwrap();
    connection
}

fn history_snapshot(connection: &Connection) -> Vec<(i64, String, String, String, i64)> {
    connection
        .prepare("SELECT id,thread_id,kind,payload,created_at FROM history_records ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn assert_core_history_schema(connection: &Connection) {
    let columns = connection
        .prepare("PRAGMA table_info(history_records)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        columns,
        ["id", "thread_id", "kind", "payload", "created_at"]
    );
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        USER_SCHEMA_VERSION
    );
    assert_eq!(
        connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    check_user_foreign_keys(connection).unwrap();
    let legacy_objects: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('history_records_request_input','history_turns','history_record_turns')",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(legacy_objects, 0);
}

#[test]
fn history_schema_upgrade_preserves_payloads_ids_sequence_and_foreign_keys() {
    let mut fresh = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut fresh).unwrap();
    assert_core_history_schema(&fresh);

    for version in [7, 8] {
        let mut connection = legacy_database(version);
        let original = history_snapshot(&connection);
        for _ in 0..2 {
            ensure_user_schema(&mut connection).unwrap();
            assert_core_history_schema(&connection);
            assert_eq!(history_snapshot(&connection), original);
            let references: (i64, i64, i64) = connection.query_row(
                "SELECT c.input_record_id,c.output_record_id,a.input_record_id FROM worker_calls c,reasoning_audits a",
                [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).unwrap();
            assert_eq!(references, (7, 12, 7));
        }
        let id = persist_history_record(
            &connection,
            HistoryRecordInsert {
                thread_id: "a",
                kind: "input",
                payload: &json!({"role":"user","content":"new input"}),
                created_at: 200,
            },
        )
        .unwrap();
        assert_eq!(id, 1001, "deleted record IDs must never be reused");
        connection
            .execute("DELETE FROM threads WHERE id='a'", [])
            .unwrap();
        assert_eq!(history_snapshot(&connection), vec![original[4].clone()]);
        check_user_foreign_keys(&connection).unwrap();
    }
}

#[test]
fn failed_history_schema_upgrade_rolls_back_columns_index_version_and_data() {
    let mut connection = legacy_database(8);
    let original = history_snapshot(&connection);
    connection
        .execute_batch("CREATE VIEW legacy_history_view AS SELECT role FROM history_records")
        .unwrap();
    assert!(ensure_user_schema(&mut connection).is_err());
    assert_eq!(history_snapshot(&connection), original);
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('history_records')",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        9
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name='history_records_request_input'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    connection
        .execute_batch("DROP VIEW legacy_history_view")
        .unwrap();
    ensure_user_schema(&mut connection).unwrap();
    assert_core_history_schema(&connection);
    assert_eq!(history_snapshot(&connection), original);
}

#[tokio::test]
async fn history_appends_and_restart_recovery_use_only_core_columns() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "core-history-user").unwrap();
    let thread = create_test_thread(&state, &user).await;
    let input_id = user_db(&state, &user, false, {
        let id = thread.id.clone();
        move |connection| {
            Ok(insert_record(
                connection,
                &id,
                "input",
                json!({"role":"user","content":"input"}),
            ))
        }
    })
    .await
    .unwrap();
    let output = [
        ResponseItem::from_value(json!({"type":"reasoning","encrypted_content":"opaque","summary":[{"type":"summary_text","text":"Thought"}]})).unwrap(),
        ResponseItem::from_value(json!({"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Answer"}]})).unwrap(),
    ];
    append_response_output_items(&state, &user, &thread, input_id, &output)
        .await
        .unwrap();
    let tool_payload = json!({"type":"function_call_output","call_id":"call","output":"工具输出"});
    let tail = append_tool_output_item(&state, &user, &thread, input_id, &tool_payload)
        .await
        .unwrap();
    let checkpoint = persist_thread_checkpoint(
        &state,
        &user,
        &thread,
        input_id,
        tail,
        "Checkpoint".to_owned(),
    )
    .await
    .unwrap();
    assert!(finalize_request_failure(&state, &user, &thread, input_id, "fixture failure").await);
    user_db(&state, &user, false, {
        let id = thread.id.clone();
        move |connection| {
            connection.execute("UPDATE threads SET status='running' WHERE id=?", [id])?;
            Ok(())
        }
    })
    .await
    .unwrap();
    recover_interrupted_requests(&state.data_dir).unwrap();
    let records = history_for(&state, &user, thread.id.clone()).await.unwrap();
    assert_eq!(records.len(), 7);
    assert_eq!(records[1].payload["encrypted_content"], "opaque");
    assert_eq!(records[1].payload["summary"][0]["text"], "Thought");
    assert_eq!(records[2].payload["phase"], "final_answer");
    assert_eq!(records[2].payload["content"][0]["text"], "Answer");
    assert_eq!(records[3].payload, tool_payload);
    assert_eq!(
        records[4].payload,
        json!({"role":"developer","content":"Checkpoint"})
    );
    assert_eq!(records[5].kind, "activity");
    assert_eq!(
        records[5].payload["content"],
        "Request failed: fixture failure"
    );
    assert_eq!(records[6].kind, "activity");
    assert_eq!(
        records[6].payload["content"],
        "Request interrupted by a Cybion restart"
    );
    user_db(&state, &user, false, move |connection| {
        assert_core_history_schema(connection);
        assert_eq!(load_thread(connection, &thread.id)?.status, "failed");
        let context = compile_thread_context(connection, &thread.id, checkpoint)?;
        assert_eq!(
            context.items,
            vec![json!({"role":"developer","content":"Checkpoint"})]
        );
        Ok(())
    })
    .await
    .unwrap();
}
