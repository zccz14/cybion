//! The request tail.
//!
//! Every inference request carries one item that is not part of the
//! conversation itself: the Thread's own bookkeeping — the notes it still owes,
//! what the Thread has spent, and the nudge that hands an unfinished turn back
//! to the model. That item is frozen as an `activity` record *before* the
//! request compiles, inside the same transaction, so the compiled request stays
//! a pure function of its record range: the compiler reads records and nothing
//! else, and replaying the same range twice produces the same items.
//!
//! INVARIANT: one tail record is written per inference attempt, and only the
//! record named by `idx_tail` replays. A tail left behind by a failed attempt
//! stays in history as evidence and never reaches the model, because the newer
//! freeze supersedes it.
//!
//! The record carries the rendered text, not the inputs it was rendered from:
//! the bytes the model read stay recoverable across renderer changes, the same
//! way a `manual_loaded` record carries its copy.

use super::*;

/// `history_records.kind` stays `activity`; the payload names the type, as
/// `manual_loaded` and `context` records do.
pub(super) const TYPE: &str = "request_tail";

/// A Thread at this share of its context budget is told to narrow its next
/// steps instead of being surprised by a compaction.
const CONTEXT_PRESSURE_PERCENT: i128 = 80;

fn is_tail(kind: &str, payload: &str) -> bool {
    if kind != "activity" {
        return false;
    }
    serde_json::from_str::<Value>(payload)
        .ok()
        .is_some_and(|payload| matches!(payload.get("type").and_then(Value::as_str), Some(TYPE)))
}

/// The tail record this range ends at, when it ends at one. Never an earlier
/// tail: the newest freeze supersedes every older one.
pub(super) fn at(
    connection: &Connection,
    thread_id: &str,
    idx_tail: i64,
) -> Result<Option<(i64, i64, String, String)>, ApiError> {
    let row = connection
        .query_row(
            "SELECT id,created_at,kind,payload FROM history_records WHERE id=? AND thread_id=?",
            params![idx_tail, thread_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    Ok(row.filter(|(_, _, kind, payload)| is_tail(kind, payload)))
}

/// What one Thread has spent so far, plus the context its last request read.
/// One aggregate over the Thread's audits and one O(1) row for its last request:
/// no stored total, no triggers, nothing to keep in step.
#[derive(Debug, Default)]
struct Spend {
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
    cost_usd_nanos: i64,
    settled: i64,
    last_input_tokens: Option<i64>,
    last_cost_usd_nanos: Option<i64>,
    budget: Option<i64>,
}

/// Never fatal: a Thread whose rollup cannot be read loses its spend line, not
/// its request. The line is useful, never essential.
fn spend(connection: &Connection, thread_id: &str) -> Option<Spend> {
    match read_spend(connection, thread_id) {
        Ok(spend) => Some(spend),
        Err(error) => {
            tracing::warn!(error = %error.message, "could not read a Thread's spend");
            None
        }
    }
}

fn read_spend(connection: &Connection, thread_id: &str) -> Result<Spend, ApiError> {
    // The same aggregate `THREAD_USAGE_SELECT` computes for the UI, narrowed to
    // one Thread: an index scan over this Thread's audits, cheaper than the
    // context estimate the very same request already pays for. Recomputed, never
    // carried forward from the previous tail: cost settles asynchronously, so a
    // running total would miss a settlement that landed after it was written.
    let usage = connection.query_row(
        "SELECT COUNT(*),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cached_tokens),0),COALESCE(SUM(cost_usd_nanos),0),
                COALESCE(SUM(CASE WHEN cost_usd_nanos IS NOT NULL THEN 1 ELSE 0 END),0)
         FROM reasoning_audits WHERE thread_id=?",
        [thread_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        },
    )?;
    let last = connection
        .query_row(
            "SELECT input_tokens,cost_usd_nanos FROM reasoning_audits
             WHERE thread_id=? AND request_kind='inference' AND input_tokens IS NOT NULL
             ORDER BY id DESC LIMIT 1",
            [thread_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()?;
    // The Thread's own budget, then the account default. A missing default row
    // means the built-in budget, which the caller's defaults also assume.
    let budget: Option<i64> = connection.query_row(
        "SELECT COALESCE(
             (SELECT context_budget_tokens FROM threads WHERE id=?),
             (SELECT context_budget_tokens FROM thread_defaults WHERE id=1))",
        [thread_id],
        |row| row.get(0),
    )?;
    Ok(Spend {
        requests: usage.0,
        input_tokens: usage.1,
        output_tokens: usage.2,
        cached_tokens: usage.3,
        cost_usd_nanos: usage.4,
        settled: usage.5,
        last_input_tokens: last.and_then(|(input, _)| input),
        last_cost_usd_nanos: last.and_then(|(_, cost)| cost),
        budget,
    })
}

fn tokens(value: i64) -> String {
    match value {
        value if value >= 1_000_000 => format!("{:.2}M", value as f64 / 1_000_000.0),
        value if value >= 1_000 => format!("{:.1}k", value as f64 / 1_000.0),
        value => value.to_string(),
    }
}

fn dollars(nanos: i64) -> String {
    let value = nanos as f64 / 1_000_000_000.0;
    if value > 0.0 && value < 0.01 {
        "<$0.01".to_owned()
    } else {
        format!("${value:.2}")
    }
}

impl Spend {
    /// The one line the Thread reads about itself. Reported usage and settled
    /// amounts only: an unsettled call is never priced as free.
    fn line(&self) -> String {
        let cache = if self.input_tokens > 0 {
            Some(self.cached_tokens as f64 / self.input_tokens as f64 * 100.0)
        } else {
            None
        };
        let mut line = format!(
            "[spend] {} tokens total ({} in / {} out{}).",
            tokens(self.input_tokens + self.output_tokens),
            tokens(self.input_tokens),
            tokens(self.output_tokens),
            cache.map_or_else(String::new, |share| format!(", cache {share:.0}%")),
        );
        if self.settled == 0 {
            line.push_str(if self.requests == 0 {
                " Nothing spent yet."
            } else {
                " No cost settled yet."
            });
        } else {
            line.push_str(&format!(" {}", dollars(self.cost_usd_nanos)));
            let settled = if self.settled < self.requests {
                format!(
                    " settled over {} of {} requests.",
                    self.settled, self.requests
                )
            } else {
                format!(" settled over {} requests.", self.requests)
            };
            line.push_str(&settled);
        }
        if let Some(input) = self.last_input_tokens {
            line.push_str(&format!(" Last request {} tokens", tokens(input)));
            if let Some(cost) = self.last_cost_usd_nanos {
                line.push_str(&format!(" / {}", dollars(cost)));
            }
            line.push('.');
        }
        line
    }

    /// The context sentence, which is also the only place the Thread is told
    /// when its budget is nearly gone: automatic compaction is about to replace
    /// the conversation, so the model should write down what matters first.
    fn context(&self) -> Option<String> {
        let input = self.last_input_tokens?;
        let budget = self.budget?;
        if budget <= 0 {
            return Some(format!(
                "Context {} tokens; automatic compaction is off.",
                tokens(input)
            ));
        }
        let share = (i128::from(input) * 100 / i128::from(budget)).max(0);
        let mut line = format!(
            "Context {} of the {} budget ({share}%).",
            tokens(input),
            tokens(budget)
        );
        if share >= CONTEXT_PRESSURE_PERCENT {
            line.push_str(
                " Compaction is close: prefer narrow reads, and write what matters into your reply.",
            );
        }
        Some(line)
    }
}

/// Freezes this request's tail and returns the record id. Called inside the
/// transaction that compiles the request, after the Manual copies, so the tail
/// is the last record of the range the model reads.
pub(super) fn append(
    connection: &Connection,
    thread_id: &str,
    nudge: Option<&str>,
) -> Result<Option<i64>, ApiError> {
    let mut text = String::new();
    if let Some(block) = notes::injection_block(connection, thread_id)? {
        text.push_str(&block);
        text.push_str("\n\n");
    }
    let mut reported = Value::Null;
    if let Some(spend) = spend(connection, thread_id) {
        text.push_str(&spend.line());
        if let Some(context) = spend.context() {
            text.push(' ');
            text.push_str(&context);
        }
        reported = json!({
            "requests": spend.requests,
            "input_tokens": spend.input_tokens,
            "output_tokens": spend.output_tokens,
            "cached_tokens": spend.cached_tokens,
            "cost_usd_nanos": spend.cost_usd_nanos,
            "cost_settled_requests": spend.settled,
            "context_tokens": spend.last_input_tokens,
            "context_budget_tokens": spend.budget,
        });
    }
    if let Some(nudge) = nudge {
        // The nudge closes the tail: the most recent instruction in the request
        // is "the Thread is not done", while the user's message stays the goal.
        text.push_str("\n\n");
        text.push_str(nudge);
    }
    if text.is_empty() {
        return Ok(None);
    }
    let payload = json!({ "type": TYPE, "text": text, "spend": reported });
    // A tail that cannot be written must not cost the request: the model simply
    // reads a request without it, exactly as before this feature existed.
    match persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id,
            kind: "activity",
            payload: &payload,
            created_at: now(),
        },
    ) {
        Ok(id) => Ok(Some(id)),
        Err(error) => {
            tracing::warn!(error = %error.message, "could not freeze a request tail");
            Ok(None)
        }
    }
}

/// Whether a tail record replays at all: a record that froze no text is
/// evidence only.
pub(super) fn replays(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|payload| {
            payload
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|text| !text.is_empty())
}

/// A tail record replays as the developer message it froze: the folded card in
/// the conversation is the same text the model reads.
pub(super) fn message(payload: &Value) -> Option<Value> {
    if payload.get("type").and_then(Value::as_str)? != TYPE {
        return None;
    }
    let content = payload.get("text").and_then(Value::as_str)?;
    if content.is_empty() {
        return None;
    }
    Some(json!({ "role": "developer", "content": content }))
}
