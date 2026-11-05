//! Blocked Threads (受阻).
//!
//! A blocked Thread is waiting on its user: the model said it cannot go on, and
//! the Thread must not report itself as finished afterwards. The flag is its own
//! axis and never a value of the runtime `status` column, because `status` is
//! written on every turn boundary — idle on finalization, failed on error — and
//! a blocked Thread has to survive both.
//!
//! There is no unblock tool. The user's next message clears the flag (see
//! `clear_on_input`, called from the one place that writes an `input` record), so
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

/// The user spoke, so the Thread is no longer waiting on them. Every input
/// record passes through here; a system-written input (a continuation nudge, if
/// one is ever added) must not, or it would silently unblock a Thread no human
/// ever looked at.
pub(super) fn clear_on_input(connection: &Connection, thread_id: &str) -> Result<(), ApiError> {
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
