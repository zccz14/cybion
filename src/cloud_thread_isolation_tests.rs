//! Isolation probes: a Thread must never read another Thread's records.
//!
//! Each test here states one isolation claim the platform relies on and fails
//! if the claim is broken. They exist because a child Thread once reported a
//! task nobody had given it; before blaming the model, the platform must be
//! able to show that its compiled context is a function of its own records.

use super::tests::{insert_record, insert_upstream, test_state};
use super::*;

async fn thread_input(state: &AppState, user: &User, thread_id: &str, text: &str) -> i64 {
    let id = thread_id.to_owned();
    let item = input_message(text.to_owned(), Vec::new(), Vec::new()).unwrap();
    user_db(state, user, true, move |connection| {
        Ok(insert_record(connection, &id, "input", item))
    })
    .await
    .unwrap()
}

async fn new_thread(state: &AppState, user: &User, title: &str) -> ThreadView {
    let upstream = insert_upstream(state, user, "fixture", "http://127.0.0.1:1").await;
    create_thread_for(
        state,
        user,
        CreateThreadInput {
            search_source: None,
            preset: None,
            budget_usd_nanos: None,
            title: Some(title.to_owned()),
            external_ref: None,
            model: Some("test-model".to_owned()),
            upstream_id: Some(upstream.id),
            reasoning_effort: None,
            service_tier_fast: None,
            initial_manual_ids: None,
            context_budget_tokens: None,
            minimal_mode: None,
            image_generation_model: None,
            max_loaded_manuals: None,
            audio_transcription_model: None,
        },
        ThreadOrigin::Web,
    )
    .await
    .unwrap()
}

async fn compiled(state: &AppState, user: &User, thread_id: &str) -> CompiledThreadContext {
    let id = thread_id.to_owned();
    user_db(state, user, false, move |connection| {
        let tail = latest_protocol_record_id(connection, &id)?;
        compile_thread_context(connection, Path::new("/nonexistent"), &id, tail)
    })
    .await
    .unwrap()
}

fn rendered(context: &CompiledThreadContext) -> String {
    context
        .items
        .iter()
        .map(|item| item.to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// HYPOTHESIS 1: a child's first input is replaced by, or mixed with, its
/// parent's context.
#[tokio::test(flavor = "multi_thread")]
async fn a_child_first_input_is_exactly_the_task_it_was_given() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "isolation-child-input").unwrap();
    let parent = new_thread(&state, &user, "parent").await;
    // The parent carries a mission of its own. Nothing of it may reach the child.
    thread_input(&state, &user, &parent.id, "PARENT-ONLY: send three emails").await;
    let created = subthreads::create_tool_output(
        &state,
        &user,
        &parent.id,
        &json!({"task": "CHILD-TASK: add use_when to thread presets"}).to_string(),
    )
    .await
    .unwrap();
    let child_id = created["thread_id"].as_str().unwrap().to_owned();
    // `create_tool_output` hands the first input to a spawned task; wait for it.
    let mut inputs: Vec<String> = Vec::new();
    for _ in 0..100 {
        let id = child_id.clone();
        inputs = user_db(&state, &user, false, move |connection| {
            let mut statement = connection.prepare(
                "SELECT payload FROM history_records WHERE thread_id=? AND kind='input' ORDER BY id",
            )?;
            let rows = statement.query_map([&id], |row| row.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
        .unwrap();
        if !inputs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        inputs.len(),
        1,
        "a child starts with exactly one input: {inputs:?}"
    );
    assert!(inputs[0].contains("CHILD-TASK"), "{}", inputs[0]);
    let child = compiled(&state, &user, &child_id).await;
    assert!(
        !rendered(&child).contains("PARENT-ONLY"),
        "the parent's history reached the child: {}",
        rendered(&child)
    );
}

/// HYPOTHESIS 2: a checkpoint / note / request tail written for one Thread is
/// read by another.
#[tokio::test(flavor = "multi_thread")]
async fn one_threads_checkpoint_notes_and_tail_never_enter_another() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "isolation-checkpoint").unwrap();
    let a = new_thread(&state, &user, "alpha").await;
    let b = new_thread(&state, &user, "beta").await;
    let a_id = a.id.clone();
    let b_id = b.id.clone();
    user_db(&state, &user, true, move |connection| {
        insert_record(
            connection,
            &a_id,
            "checkpoint",
            json!({"role":"developer","content":"ALPHA-CHECKPOINT: sent three emails"}),
        );
        insert_record(
            connection,
            &a_id,
            "input",
            json!({"role":"user","content":"ALPHA-TURN"}),
        );
        insert_record(
            connection,
            &a_id,
            "activity",
            json!({"type":"request_tail","text":"ALPHA-TAIL"}),
        );
        connection
            .execute(
                "INSERT INTO notes(id,thread_id,text,created_at) VALUES('n-a',?,'ALPHA-NOTE',?)",
                params![a_id, now()],
            )
            .unwrap();
        insert_record(
            connection,
            &b_id,
            "input",
            json!({"role":"user","content":"BETA-TURN"}),
        );
        Ok(())
    })
    .await
    .unwrap();
    // A note written for B reads only B's notes back.
    let b_notes = user_db(&state, &user, false, {
        let b = b.id.clone();
        move |connection| notes::injection_block(connection, &b)
    })
    .await
    .unwrap();
    assert_eq!(b_notes, None, "B read A's note: {b_notes:?}");
    let b_context = rendered(&compiled(&state, &user, &b.id).await);
    for foreign in ["ALPHA-CHECKPOINT", "ALPHA-TAIL", "ALPHA-NOTE", "ALPHA-TURN"] {
        assert!(
            !b_context.contains(foreign),
            "{foreign} reached B: {b_context}"
        );
    }
}

/// HYPOTHESIS 4: recovery replays a Thread with another Thread's latest input.
#[tokio::test(flavor = "multi_thread")]
async fn recovery_reads_each_running_threads_own_latest_input() {
    let (_root, state) = test_state();
    let user = user_for_subject(&state, "isolation-recovery").unwrap();
    let a = new_thread(&state, &user, "alpha").await;
    let b = new_thread(&state, &user, "beta").await;
    let a_turn = thread_input(&state, &user, &a.id, "ALPHA-TURN").await;
    let b_turn = thread_input(&state, &user, &b.id, "BETA-TURN").await;
    assert_ne!(a_turn, b_turn);
    let (a_latest, b_latest) = user_db(&state, &user, false, {
        let (a, b) = (a.id.clone(), b.id.clone());
        move |connection| {
            Ok((
                thread_controls::latest_request_record_id(connection, &a)?,
                thread_controls::latest_request_record_id(connection, &b)?,
            ))
        }
    })
    .await
    .unwrap();
    assert_eq!(
        a_latest,
        Some(a_turn),
        "recovery would replay A with the wrong record"
    );
    assert_eq!(
        b_latest,
        Some(b_turn),
        "recovery would replay B with the wrong record"
    );
}
