//! The request tail.
//!
//! Every inference request carries one item that is not part of the
//! conversation itself: the Thread's own bookkeeping — the notes it still owes,
//! what the Thread has spent, how long it has been running, and the nudge that
//! hands an unfinished turn back to the model. That item is frozen as an `activity` record *before* the
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

/// A turn that opens after this much silence is a new session to the model, not
/// a continuation of the old one, and saying so costs one clause.
const QUIET_SECONDS: i64 = 3_600;

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
    /// How long that last request took. None when it never finished: an
    /// aborted attempt is not a pace to report.
    last_request_seconds: Option<i64>,
    /// The user message that opened the current turn, and how many inference
    /// requests this Thread has begun since it.
    turn_started_at: Option<i64>,
    turn_requests: i64,
    /// Silence immediately before that message, None on the Thread's first turn.
    quiet_seconds: Option<i64>,
    budget: Option<i64>,
    /// The one instant this tail was frozen at, so the clock it prints and the
    /// clock the model is meant to reason from are the same.
    read_at: i64,
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
            "SELECT input_tokens,cost_usd_nanos,started_at,finished_at FROM reasoning_audits
             WHERE thread_id=? AND request_kind='inference' AND input_tokens IS NOT NULL
             ORDER BY id DESC LIMIT 1",
            [thread_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?;
    // Two point lookups over indexes this schema already keeps: the newest user
    // record opens the turn, the record before it says how long the Thread was
    // silent. The count since that message is one index range. All three are
    // cheaper than the context estimate this very request already pays for, and
    // a Thread that cannot read them loses the clock, never the request.
    let turn = connection
        .query_row(
            "SELECT id,created_at FROM history_records
             WHERE thread_id=? AND kind='input'
             ORDER BY created_at DESC,id DESC LIMIT 1",
            [thread_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;
    let turn_requests = match turn {
        Some((_, started_at)) => connection.query_row(
            "SELECT COUNT(*) FROM reasoning_audits
             WHERE thread_id=? AND request_kind='inference' AND started_at>=?",
            params![thread_id, started_at],
            |row| row.get::<_, i64>(0),
        )?,
        None => 0,
    };
    let quiet_seconds = match turn {
        Some((id, started_at)) => connection
            .query_row(
                "SELECT created_at FROM history_records
                 WHERE thread_id=? AND id<? ORDER BY id DESC LIMIT 1",
                params![thread_id, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .map(|previous| (started_at - previous).max(0)),
        None => None,
    };
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
        last_input_tokens: last.and_then(|(input, _, _, _)| input),
        last_cost_usd_nanos: last.and_then(|(_, cost, _, _)| cost),
        last_request_seconds: last
            .and_then(|(_, _, started, finished)| finished.map(|f| (f - started).max(0))),
        turn_started_at: turn.map(|(_, created_at)| created_at),
        turn_requests,
        quiet_seconds,
        budget,
        read_at: now(),
    })
}

fn tokens(value: i64) -> String {
    match value {
        value if value >= 1_000_000 => format!("{:.2}M", value as f64 / 1_000_000.0),
        value if value >= 1_000 => format!("{:.1}k", value as f64 / 1_000.0),
        value => value.to_string(),
    }
}

/// A span the way a person reads it: 41s, 3m12s, 2h05m, 1d01h.
fn duration(seconds: i64) -> String {
    let seconds = seconds.max(0);
    match seconds {
        seconds if seconds < 60 => format!("{seconds}s"),
        seconds if seconds < 3_600 => format!("{}m{:02}s", seconds / 60, seconds % 60),
        seconds if seconds < 86_400 => format!("{}h{:02}m", seconds / 3_600, seconds % 3_600 / 60),
        seconds => format!("{}d{:02}h", seconds / 86_400, seconds % 86_400 / 3_600),
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
            if let Some(seconds) = self.last_request_seconds {
                line.push_str(&format!(" in {}", duration(seconds)));
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

impl Spend {
    /// The Thread's clock. What it spent says how much is gone; only this says
    /// how long it has been going, which is what separates a Thread that is
    /// working from one that has been retrying the same command for eleven
    /// minutes. Absolute time is UTC and labelled as such: the controller keeps
    /// no timezone of its own, and a wrong local time is worse than a right UTC.
    fn clock(&self) -> Option<String> {
        let stamp = chrono::DateTime::from_timestamp(self.read_at, 0)?;
        let mut line = format!("It is now {} UTC.", stamp.format("%Y-%m-%d %H:%M (%a)"));
        if let Some(started_at) = self.turn_started_at
            && self.turn_requests > 0
        {
            let elapsed = (self.read_at - started_at).max(0);
            line.push_str(&format!(
                " This turn: {} request{} over {}.",
                self.turn_requests,
                if self.turn_requests == 1 { "" } else { "s" },
                duration(elapsed)
            ));
            if let Some(quiet) = self.quiet_seconds
                && quiet >= QUIET_SECONDS
            {
                line.push_str(&format!(
                    " It sat quiet for {} before this turn.",
                    duration(quiet)
                ));
            }
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
        if let Some(clock) = spend.clock() {
            text.push(' ');
            text.push_str(&clock);
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
            "last_request_seconds": spend.last_request_seconds,
            "turn_started_at": spend.turn_started_at,
            "turn_requests": spend.turn_requests,
            "quiet_seconds": spend.quiet_seconds,
            "read_at": spend.read_at,
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
