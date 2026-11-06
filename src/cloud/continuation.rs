//! Notes continuation (目标模式): a Thread does not end its turn while it still
//! owes open notes.
//!
//! When a response settles with no tool calls and the Thread still holds open
//! notes, the kernel records the fact, hands the model a runtime nudge and lets
//! the turn go on — at most [`MAX_PER_TURN`] times per input. The nudge lives in
//! the request copy only: a fake user turn would read as the person speaking and
//! would outlive the single moment it was meant for.
//!
//! Two rules keep the loop honest. A blocked Thread never continues, so a model
//! that cannot finish has a legal exit instead of a reason to cross out work it
//! did not do. And a Thread that exhausts the budget stops with a visible
//! record: the runtime must never claim the model is blocked on its behalf.

use super::*;

/// Automatic continuations one turn may receive. The cap bounds what a single
/// input can cost before a human looks at it again.
pub(super) const MAX_PER_TURN: i64 = 3;
const TYPE_CONTINUE: &str = "notes_continuation";
const TYPE_STOPPED: &str = "notes_continuation_stopped";

/// Decides whether this turn goes on, and returns the nudge to hand the model.
/// `None` ends the turn: nothing is owed, the Thread is blocked on a human, the
/// budget is spent, or the user is already gone.
pub(super) async fn decide(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input_record_id: i64,
) -> Result<Option<String>, ApiError> {
    // The deployment switch comes first: with it off nothing is recorded and
    // no turn is ever handed back, exactly as before the loop existed.
    if !notes::continuation_enabled(state).await? {
        return Ok(None);
    }
    let thread_id = thread_id.to_owned();
    user_db(state, user, true, move |connection| {
        decide_in(connection, &thread_id, input_record_id)
    })
    .await
}

pub(super) fn decide_in(
    connection: &mut Connection,
    thread_id: &str,
    input_record_id: i64,
) -> Result<Option<String>, ApiError> {
    let blocked: i64 = connection.query_row(
        "SELECT blocked FROM threads WHERE id=?",
        [thread_id],
        |row| row.get(0),
    )?;
    // A blocked Thread is waiting on its user: continuing would talk over them.
    if blocked == 1 {
        return Ok(None);
    }
    let open: i64 = connection.query_row(
        "SELECT COUNT(*) FROM notes WHERE thread_id=? AND done_at IS NULL",
        [thread_id],
        |row| row.get(0),
    )?;
    if open == 0 {
        return Ok(None);
    }
    let used = continuations(connection, thread_id, input_record_id, TYPE_CONTINUE)?;
    if used >= MAX_PER_TURN {
        // Record the stop once per turn, so the Thread shows why it ended with
        // debts still open instead of looking like a plain completion.
        if continuations(connection, thread_id, input_record_id, TYPE_STOPPED)? == 0 {
            record(
                connection,
                thread_id,
                json!({
                    "type": TYPE_STOPPED,
                    "input_record_id": input_record_id,
                    "open": open,
                }),
            )?;
        }
        return Ok(None);
    }
    let nudge = used + 1;
    record(
        connection,
        thread_id,
        json!({
            "type": TYPE_CONTINUE,
            "input_record_id": input_record_id,
            "nudge": nudge,
            "open": open,
        }),
    )?;
    Ok(Some(nudge_text(nudge, open)))
}

fn continuations(
    connection: &Connection,
    thread_id: &str,
    input_record_id: i64,
    kind: &str,
) -> Result<i64, ApiError> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM history_records
         WHERE thread_id=? AND kind='activity' AND json_valid(payload)
           AND json_extract(payload,'$.type')=?
           AND json_extract(payload,'$.input_record_id')=?",
        params![thread_id, kind, input_record_id],
        |row| row.get(0),
    )?)
}

fn record(connection: &Connection, thread_id: &str, payload: Value) -> Result<(), ApiError> {
    persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id,
            kind: "activity",
            payload: &payload,
            created_at: now(),
        },
    )?;
    Ok(())
}

/// The runtime's voice, not the user's: it says who is speaking, states the
/// fact, names the two legal moves (finish it, or block), and forbids the three
/// things a forced loop invites — faking a cross out, restating the plan, and
/// redoing recorded work.
fn nudge_text(nudge: i64, open: i64) -> String {
    let (notes, verb) = if open == 1 {
        ("note", "is")
    } else {
        ("notes", "are")
    };
    if nudge >= MAX_PER_TURN {
        format!(
            "[Runtime continuation {nudge} of {MAX_PER_TURN}, the last one — not the user; the user has not replied]\n\
             This is the final automatic continuation: the Thread stops after this turn.\n\
             Finish and cross out the remaining {open} {notes} now, or call block_thread with what\n\
             blocks the user's side. A note left open without an issue stops the Thread with that\n\
             debt unresolved."
        )
    } else {
        format!(
            "[Runtime continuation {nudge} of {MAX_PER_TURN} — not the user; the user has not replied]\n\
             The {open} {notes} above {verb} still open, and this Thread does not end while they are open.\n\
             Work the next one now. Cross a note out only in the turn you actually finished it;\n\
             do not restate this plan; do not redo work already recorded above; do not add a new\n\
             note unless one of these genuinely has to be split.\n\
             If a note cannot be finished, call block_thread once and say what the user must do."
        )
    }
}
