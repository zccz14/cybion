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

fn record_at(connection: &Connection, kind: &str, payload: Value, created_at: i64) -> i64 {
    persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id: "th",
            kind,
            payload: &payload,
            created_at,
        },
    )
    .unwrap()
}

fn record(connection: &Connection, kind: &str, payload: Value) -> i64 {
    record_at(connection, kind, payload, now())
}

/// One finished inference request, stamped where the caller wants it.
fn audit_at(connection: &Connection, started_at: i64, seconds: i64, input: i64) -> i64 {
    connection
        .execute(
            "INSERT INTO reasoning_audits(thread_id,request_kind,model,status,started_at,
                                          finished_at,input_tokens,output_tokens,cached_tokens)
             VALUES('th','inference','model','completed',?,?,?,100,0)",
            params![started_at, started_at + seconds, input],
        )
        .unwrap();
    connection.last_insert_rowid()
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
fn the_spend_line_follows_the_audit_rows() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    let settled = audit(&connection, 1_000, 100, 900);
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=200000000 WHERE id=?",
            params![settled],
        )
        .unwrap();
    let line = |connection: &Connection| {
        let tail = request_tail::append(connection, "th", None)
            .unwrap()
            .unwrap();
        tail_text(
            &compile_thread_context(connection, directory.path(), "th", tail)
                .unwrap()
                .items,
        )
    };
    let text = line(&connection);
    assert!(text.contains("$0.20"), "{text}");
    assert!(text.contains("1.1k tokens total"), "{text}");

    // A settlement that lands late is counted too: the aggregate is recomputed,
    // never carried forward.
    connection
        .execute(
            "UPDATE reasoning_audits SET cost_usd_nanos=50000000 WHERE id=?",
            params![settled],
        )
        .unwrap();
    let text = line(&connection);
    assert!(text.contains("$0.05"), "{text}");

    // Deleting the audit row takes its contribution with it.
    connection
        .execute("DELETE FROM reasoning_audits WHERE id=?", params![settled])
        .unwrap();
    let text = line(&connection);
    assert!(text.contains("Nothing spent yet"), "{text}");
}

#[test]
fn an_old_database_drops_the_rollup_and_still_reports_spend() {
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
    persist_history_record(
        &connection,
        HistoryRecordInsert {
            thread_id: "old",
            kind: "input",
            payload: &json!({"role":"user","content":"go"}),
            created_at: now(),
        },
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
    // The shape v0.6.78 left behind: the derived table and one of its triggers.
    connection
        .execute_batch(
            "CREATE TABLE thread_rollup (thread_id TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0);
             CREATE TRIGGER thread_rollup_audit_insert AFTER INSERT ON reasoning_audits BEGIN SELECT 1; END;
             PRAGMA user_version = 58;",
        )
        .unwrap();
    drop(connection);

    let reopened = open_user(&path, true).unwrap();
    let version: i64 = reopened
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, USER_SCHEMA_VERSION);
    let objects: i64 = reopened
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE 'thread_rollup%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(objects, 0, "the derived table and its triggers are gone");

    let directory = tempfile::tempdir().unwrap();
    let tail = request_tail::append(&reopened, "old", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&reopened, directory.path(), "old", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("$0.05"), "{text}");
}

/// The tail is the only place a Thread can learn how long it has been going:
/// its notes say what to do, its spend says how much is gone, and neither
/// answers "how long have I been on this".
#[test]
fn the_tail_reports_how_long_the_last_request_and_this_turn_took() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    let opened = now() - 200;
    record_at(
        &connection,
        "input",
        json!({"role":"user","content":"go"}),
        opened,
    );
    audit_at(&connection, opened + 20, 41, 1_000);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("Last request 1.0k tokens in 41s"), "{text}");
    assert!(text.contains("This turn: 1 request over 3m"), "{text}");
    assert!(text.contains("UTC"), "{text}");
}

/// An attempt that never finished, or one whose timestamps predate this turn,
/// leaves the clock silent rather than reporting a fabricated zero.
#[test]
fn a_request_without_a_finish_reports_no_duration() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    audit(&connection, 1_000, 100, 0);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("Last request 1.0k tokens."), "{text}");
    assert!(!text.contains(" in 0s"), "{text}");
}

/// Silence is only worth a clause when the Thread was actually asleep: a Thread
/// resumed a day later is a new session, and must not carry the old momentum.
#[test]
fn a_long_silence_is_named_and_a_short_one_is_not() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    let opened = now() - 60;
    record_at(
        &connection,
        "response_output",
        json!({"type":"message"}),
        opened - 90_000,
    );
    record_at(
        &connection,
        "input",
        json!({"role":"user","content":"go"}),
        opened,
    );
    audit_at(&connection, opened + 1, 5, 500);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(
        text.contains("It sat quiet for 1d01h before this turn."),
        "{text}"
    );

    // Five minutes of silence is a conversation still in progress.
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    let opened = now() - 60;
    record_at(
        &connection,
        "response_output",
        json!({"type":"message"}),
        opened - 300,
    );
    record_at(
        &connection,
        "input",
        json!({"role":"user","content":"go"}),
        opened,
    );
    audit_at(&connection, opened + 1, 5, 500);
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    assert!(!tail_text(&compiled.items).contains("sat quiet"), "{text}");
}

/// The first request of a turn has no earlier request to count, so the tail
/// reads only the clock rather than announcing "0 requests".
#[test]
fn a_fresh_thread_reads_only_the_time() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    let tail = request_tail::append(&connection, "th", None)
        .unwrap()
        .unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let text = tail_text(&compiled.items);
    assert!(text.contains("It is now"), "{text}");
    assert!(text.contains("UTC"), "{text}");
    assert!(!text.contains("This turn"), "{text}");
}
