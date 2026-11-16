//! Blocked Threads (受阻).
//!
//! A blocked Thread is waiting on its user: the model said it cannot go on, and
//! the Thread must not report itself as finished afterwards. The flag is its own
//! axis and never a value of the runtime `status` column, because `status` is
//! written on every turn boundary — idle on finalization, failed on error — and
//! a blocked Thread has to survive both.
//!
//! There is no unblock tool. The user's next message clears the flag (see
//! `clear_on_user_action`, called from the one place that writes an `input` record
//! and from the user's own Continue), so
//! the model never decides when it stops waiting.

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlockArguments {}

/// Marks one Thread blocked and reports the flag as it now stands. Blocking a
/// Thread that is already blocked keeps the original state.
pub(super) fn block(connection: &Connection, thread_id: &str) -> Result<bool, ApiError> {
    connection.execute(
        "UPDATE threads SET blocked=1 WHERE id=? AND blocked=0",
        [thread_id],
    )?;
    Ok(connection.query_row(
        "SELECT blocked FROM threads WHERE id=?",
        [thread_id],
        |row| row.get::<_, i64>(0),
    )? == 1)
}

/// The kernel stops a Thread whose settled spend reached its USD budget.
///
/// The Thread is waiting on its user — only they can raise the limit — so it
/// takes the same `blocked` axis the model's own `block_thread` uses, and the
/// one write that clears it is the same: the next `input` record. The record
/// left behind says the amount in the conversation, because a Thread stopped
/// by its budget must never read as one that simply finished.
///
/// `blocked=1` is written conditionally so a Thread that is already blocked
/// keeps its original state and does not gain a second record: resuming a
/// running Thread after a Controller restart reaches this gate again.
pub(super) fn stop_for_budget(
    connection: &mut Connection,
    thread_id: &str,
    budget_usd_nanos: i64,
    spent_usd_nanos: i64,
) -> Result<String, ApiError> {
    let content = format!(
        "Budget exhausted: {spent} settled of the {budget} limit. Raise the limit in Thread settings, then send a message to continue.",
        spent = dollars(spent_usd_nanos),
        budget = dollars(budget_usd_nanos),
    );
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = transaction.execute(
        "UPDATE threads SET blocked=1 WHERE id=? AND blocked=0",
        [thread_id],
    )?;
    if changed != 0 {
        persist_history_record(
            &transaction,
            HistoryRecordInsert {
                thread_id,
                kind: "activity",
                payload: &json!({
                    "role": "system",
                    "content": content,
                    "budget_usd_nanos": budget_usd_nanos,
                    "spent_usd_nanos": spent_usd_nanos,
                }),
                created_at: now(),
            },
        )?;
    }
    transaction.commit()?;
    Ok(content)
}

/// A settled amount the way the Thread reads it elsewhere: cents, and anything
/// under a cent does not read as no money at all.
fn dollars(nanos: i64) -> String {
    let value = nanos as f64 / 1_000_000_000.0;
    if value > 0.0 && value < 0.01 {
        "<$0.01".to_owned()
    } else {
        format!("${value:.2}")
    }
}

/// The user acted on the Thread, so it is no longer waiting on them. Two writes
/// pass through here, and both are the user's own: an `input` record (they
/// spoke) and a Continue they requested themselves. A system-written input (a
/// continuation nudge, if one is ever added) must not, or it would silently
/// unblock a Thread no human ever looked at.
///
/// A Thread stopped by its budget needs the second one as much as the first:
/// raising the limit is only an adjustment, and the Thread has to keep running
/// afterwards instead of reporting itself blocked again on finalization.
pub(super) fn clear_on_user_action(
    connection: &Connection,
    thread_id: &str,
) -> Result<(), ApiError> {
    connection.execute(
        "UPDATE threads SET blocked=0 WHERE id=? AND blocked=1",
        [thread_id],
    )?;
    Ok(())
}

/// The model-facing tool. It takes no arguments: the explanation belongs in the
/// model's answer, which is what the user reads when they open the Thread.
pub(super) async fn tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments = input.trim();
    if !arguments.is_empty() {
        serde_json::from_str::<BlockArguments>(arguments).map_err(|error| {
            ApiError::bad_request(format!("block_thread takes no arguments: {error}"))
        })?;
    }
    let thread = thread_id.to_owned();
    user_db(state, user, true, move |connection| {
        block(connection, &thread)
    })
    .await?;
    Ok(json!({
        "status": "blocked",
        "clear": "The user's next message clears this. Say in your answer what blocks them and what they must do.",
    }))
}
