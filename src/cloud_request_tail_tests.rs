use super::*;

fn tail_connection() -> Connection {
    let mut connection = Connection::open_in_memory().unwrap();
    ensure_user_schema(&mut connection).unwrap();
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at) VALUES('th','T','model','idle',1,1)",
            [],
        )
        .unwrap();
    connection
}

fn record(connection: &Connection, kind: &str, payload: Value) -> i64 {
    persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id: "th",
            kind,
            payload: &payload,
            created_at: now(),
        },
    )
    .unwrap()
}

fn note(connection: &Connection, id: &str, text: &str) {
    connection
        .execute(
            "INSERT INTO notes(id,thread_id,text,created_at) VALUES(?,'th',?,1)",
            params![id, text],
        )
        .unwrap();
}

fn audit(connection: &Connection, input: i64, output: i64, cached: i64) -> i64 {
    connection
        .execute(
            "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,
                                          input_tokens,output_tokens,cached_tokens)
             VALUES('th','inference','model','completed',1,?,?,?)",
            params![input, output, cached],
        )
        .unwrap();
    connection.last_insert_rowid()
}

/// The developer message a compiled request ends with.
fn tail_text(items: &[Value]) -> String {
    items
        .last()
        .and_then(|item| item["content"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The developer messages that came from a notes block.
fn notes_lines(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_str))
        .filter(|content| content.starts_with("Sticky notes"))
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_frozen_tail_replays_as_the_last_item_the_model_reads() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    assert_eq!(compiled.idx_tail, tail);
    let last = compiled.items.last().unwrap();
    assert_eq!(last["role"], "developer");
    let text = last["content"].as_str().unwrap();
    assert!(text.contains("完成交付"), "{text}");
    assert!(text.contains("[spend]"), "{text}");
    assert_eq!(notes_lines(&compiled.items).len(), 1);
}

#[test]
fn compiling_the_same_range_twice_reproduces_the_same_items() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    audit(&connection, 1_000, 200, 800);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let first = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let second = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    assert_eq!(first.items, second.items);
    assert_eq!(first.idx_head, second.idx_head);
}

#[test]
fn an_older_tail_is_evidence_and_never_replays() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let stale = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    note(&connection, "n2", "再检查一遍");
    let answer = record(
        &connection,
        "response_output",
        json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}),
    );
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    assert!(stale < answer && answer < tail);

    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let replayed = notes_lines(&compiled.items);
    assert_eq!(replayed.len(), 1);
    assert!(replayed[0].contains("再检查一遍"));

    // A range that ends before the newest freeze carries no tail item at all.
    let older = compile_thread_context(&connection, directory.path(), "th", answer).unwrap();
    assert!(notes_lines(&older.items).is_empty());
}

#[test]
fn a_thread_without_notes_still_reads_its_own_spend() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    let head = record(&connection, "input", json!({"role":"user","content":"go"}));
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    // The tail is not a protocol record: it never advances the replay tail on
    // its own, it only ends the range this request compiles.
    assert_eq!(latest_protocol_record_id(&connection, "th").unwrap(), head);
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    assert_eq!(compiled.items.len(), 2);
    let text = tail_text(&compiled.items);
    assert!(text.starts_with("[spend]"), "{text}");
    assert!(notes_lines(&compiled.items).is_empty());
}

#[test]
fn the_tail_names_what_the_thread_spent_and_what_settled() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    let settled = audit(&connection, 1_000, 200, 800);
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=250000000 WHERE id=?",
            params![settled],
        )
        .unwrap();
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("1.2k tokens total"), "{text}");
    assert!(text.contains("1.0k in / 200 out"), "{text}");
    assert!(text.contains("cache 80%"), "{text}");
    assert!(text.contains("$0.25"), "{text}");
    assert!(text.contains("Last request 1.0k tokens / $0.25"), "{text}");
}

#[test]
fn an_unsettled_call_is_never_reported_as_free() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    let settled = audit(&connection, 1_000, 100, 0);
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=100000000 WHERE id=?",
            params![settled],
        )
        .unwrap();
    audit(&connection, 2_000, 300, 0);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(
        text.contains("$0.10 settled over 1 of 2 requests"),
        "{text}"
    );
}

#[test]
fn the_context_sentence_warns_before_a_compaction() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    connection
        .execute(
            "UPDATE threads SET context_budget_tokens=1000 WHERE id='th'",
            [],
        )
        .unwrap();
    audit(&connection, 900, 10, 0);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(
        text.contains("Context 900 of the 1.0k budget (90%)"),
        "{text}"
    );
    assert!(text.contains("Compaction is close"), "{text}");
}

#[test]
fn the_continuation_nudge_is_frozen_into_the_tail() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let nudge = "The Thread still owes 1 open note. Cross out what you finished.";
    let tail = request_tail::append(&connection, "th", Some(nudge))
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.ends_with(nudge), "{text}");
    // The nudge is the last thing in the request, and it is a record.
    let stored: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM history_records WHERE payload LIKE '%still owes%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 1);
}

#[test]
fn the_estimator_counts_exactly_the_tail_the_compiler_replays() {
    let connection = tail_connection();
    let head = record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let with_tail = estimate_range_bytes(&connection, "th", head, tail).unwrap();
    let without_tail = estimate_range_bytes(&connection, "th", head, tail - 1).unwrap();
    assert!(with_tail > without_tail);
    assert_eq!(tail - 1, head);
}

#[test]
fn the_rollup_follows_the_audit_rows() {
    let connection = tail_connection();
    let first = audit(&connection, 1_000, 100, 900);
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=200000000 WHERE id=?",
            params![first],
        )
        .unwrap();
    let mut statement = connection
        .prepare(
            "SELECT requests,input_tokens,output_tokens,cached_tokens,
                    cost_usd_nanos,cost_settled_requests
             FROM thread_rollup WHERE thread_id='th'",
        )
        .unwrap();
    let row = |statement: &mut rusqlite::Statement| -> (i64, i64, i64, i64, i64, i64) {
        statement
            .query_row([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
    };
    assert_eq!(row(&mut statement), (1, 1_000, 100, 900, 200_000_000, 1));
    drop(statement);

    // A late settlement lands in the rollup too.
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=50000000 WHERE id=?",
            params![first],
        )
        .unwrap();
    let mut statement = connection
        .prepare(
            "SELECT requests,input_tokens,output_tokens,cached_tokens,
                    cost_usd_nanos,cost_settled_requests
             FROM thread_rollup WHERE thread_id='th'",
        )
        .unwrap();
    assert_eq!(row(&mut statement), (1, 1_000, 100, 900, 50_000_000, 1));
    drop(statement);

    // Removing a Thread takes its rollup row with it.
    connection
        .execute("DELETE FROM threads WHERE id='th'", [])
        .unwrap();
    let remaining: i64 = connection
        .query_row("SELECT COUNT(*) FROM thread_rollup", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn a_database_without_the_rollup_still_serves_a_request() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    // The shape a release once left behind: the schema version moved but the
    // rollup never arrived. Reading it must cost the spend line, never the
    // request.
    connection
        .execute_batch(
            "DROP TRIGGER IF EXISTS thread_rollup_audit_insert;
             DROP TRIGGER IF EXISTS thread_rollup_audit_tokens;
             DROP TRIGGER IF EXISTS thread_rollup_audit_cost;
             DROP TRIGGER IF EXISTS thread_rollup_audit_delete;
             DROP TRIGGER IF EXISTS thread_rollup_thread_delete;
             DROP TABLE thread_rollup;",
        )
        .unwrap();
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("完成交付"), "{text}");
    assert!(!text.contains("[spend]"), "{text}");
}

#[test]
fn opening_an_old_database_creates_the_rollup_and_fills_it() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("old.sqlite3");
    let connection = open_user(&path, true).unwrap();
    connection
        .execute(
            "INSERT INTO threads(id,title,model,status,created_at,updated_at)
             VALUES('old','O','m','idle',1,1)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,
                                          input_tokens,output_tokens,cached_tokens,cost_usd_nanos)
             VALUES('old','inference','m','completed',1,1000,100,900,50000000)",
            [],
        )
        .unwrap();
    // Rewind to the version before the rollup existed.
    connection
        .execute_batch(
            "DROP TRIGGER IF EXISTS thread_rollup_audit_insert;
             DROP TRIGGER IF EXISTS thread_rollup_audit_tokens;
             DROP TRIGGER IF EXISTS thread_rollup_audit_cost;
             DROP TRIGGER IF EXISTS thread_rollup_audit_delete;
             DROP TRIGGER IF EXISTS thread_rollup_thread_delete;
             DROP TABLE thread_rollup;
             PRAGMA user_version = 57;",
        )
        .unwrap();
    drop(connection);
    let version: i64 = open_user(&path, true)
        .unwrap()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    let reopened = open_user(&path, true).unwrap();
    let row: (i64, i64, i64, i64, i64, i64) = reopened
        .query_row(
            "SELECT requests,input_tokens,output_tokens,cached_tokens,
                    cost_usd_nanos,cost_settled_requests
             FROM thread_rollup WHERE thread_id='old'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row, (1, 1_000, 100, 900, 50_000_000, 1));
}
