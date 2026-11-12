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

/// The developer messages a compiled request carries that came from a frozen
/// tail: the notes block always names itself in its first line.
fn tail_items(items: &[Value]) -> Vec<String> {
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
    let tail = request_tail::append(&connection, "th").unwrap().unwrap();
    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    assert_eq!(compiled.idx_tail, tail);
    let last = compiled.items.last().unwrap();
    assert_eq!(last["role"], "developer");
    assert!(last["content"].as_str().unwrap().contains("完成交付"));
    assert_eq!(tail_items(&compiled.items).len(), 1);
}

#[test]
fn compiling_the_same_range_twice_reproduces_the_same_items() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let tail = request_tail::append(&connection, "th").unwrap().unwrap();
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
    let stale = request_tail::append(&connection, "th").unwrap().unwrap();
    note(&connection, "n2", "再检查一遍");
    let answer = record(
        &connection,
        "response_output",
        json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}),
    );
    let tail = request_tail::append(&connection, "th").unwrap().unwrap();
    assert!(stale < answer && answer < tail);

    let compiled = compile_thread_context(&connection, directory.path(), "th", tail).unwrap();
    let replayed = tail_items(&compiled.items);
    assert_eq!(replayed.len(), 1);
    assert!(replayed[0].contains("再检查一遍"));

    // A range that ends before the newest freeze carries no tail item at all.
    let older = compile_thread_context(&connection, directory.path(), "th", answer).unwrap();
    assert!(tail_items(&older.items).is_empty());
}

#[test]
fn a_thread_with_nothing_to_say_freezes_no_tail_and_replays_the_conversation() {
    let connection = tail_connection();
    let directory = tempfile::tempdir().unwrap();
    let head = record(&connection, "input", json!({"role":"user","content":"go"}));
    assert_eq!(request_tail::append(&connection, "th").unwrap(), None);
    assert_eq!(latest_protocol_record_id(&connection, "th").unwrap(), head);
    let compiled = compile_thread_context(&connection, directory.path(), "th", head).unwrap();
    assert_eq!(compiled.items.len(), 1);
    assert!(tail_items(&compiled.items).is_empty());
}

#[test]
fn the_estimator_counts_exactly_the_tail_the_compiler_replays() {
    let connection = tail_connection();
    let head = record(&connection, "input", json!({"role":"user","content":"go"}));
    note(&connection, "n1", "完成交付");
    let tail = request_tail::append(&connection, "th").unwrap().unwrap();
    let with_tail = estimate_range_bytes(&connection, "th", head, tail).unwrap();
    let without_tail = estimate_range_bytes(&connection, "th", head, tail - 1).unwrap();
    assert!(with_tail > without_tail);
    assert_eq!(tail - 1, head);
}
