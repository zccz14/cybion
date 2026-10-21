//! Reasoning-cost settlement.
//!
//! Every inference response carries the gateway's request ID, and a gateway
//! that serves the request-cost contract answers what that call actually cost
//! (`POST {base_url}/requests/query` with `{"ids":[...]}`). This worker asks
//! per upstream, in batches, and books the amount on the audit row, so a
//! Thread's cost is summed the same way its tokens are — from its own audit
//! records, no second pricing of the same call anywhere in Cybion.
//!
//! Two things keep the pass honest rather than optimistic:
//!
//! - Only an answered amount is stored. A gateway that has not settled a call
//!   yet answers `cost_usd_nanos: null` (or omits the request ID from `missing`),
//!   and the row keeps a NULL cost; the audit never records a zero it did not
//!   receive.
//! - Each row carries an attempt budget. Most upstreams are somebody's own API
//!   endpoint and do not serve the contract at all, so a row that never resolves
//!   stops being asked instead of being retried forever.

use super::*;

/// How often a pass runs. Settlement behind a gateway is a seconds-scale
/// affair, so this is the same order as the gateway consoles' own refresh.
const TICK_SECONDS: u64 = 5;
/// Audit rows one pass considers per user.
const SCAN_LIMIT: i64 = 200;
/// Request IDs per cost query, matching the contract's own ceiling of 1000 with
/// room for several upstreams in flight.
const QUERY_BATCH: usize = 100;
/// Attempts one row gets before its cost is given up on: twelve passes, about a
/// minute, which covers a gateway that settles on its own schedule.
pub(super) const MAX_ATTEMPTS: i64 = 12;
/// Rows older than this are not chased. A Thread's panel is read within
/// minutes of the turn, so a day-old gap is no longer worth a query.
const LOOKBACK_SECONDS: i64 = 3600;
/// Budget of one cost query.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn supervise(state: AppState) {
    loop {
        if let Err(error) = run_pass(&state).await {
            tracing::warn!(error=%error.message, "reasoning cost settlement pass failed");
        }
        tokio::time::sleep(Duration::from_secs(TICK_SECONDS)).await;
    }
}

/// One pass over every user database. A user whose settlement fails is logged
/// and skipped: one broken upstream must not stop the others from settling.
pub(super) async fn run_pass(state: &AppState) -> Result<(), ApiError> {
    let directory = state.data_dir.join("users");
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&directory).map_err(ApiError::internal)? {
        let path = entry.map_err(ApiError::internal)?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("sqlite3") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let user = user_from_id(state, id.to_owned())?;
        if let Err(error) = settle_user(state, &user).await {
            tracing::warn!(user=%user.id,error=%error.message,"reasoning cost settlement deferred database");
        }
    }
    Ok(())
}

/// One audit row that still waits for its amount.
struct PendingCall {
    audit_id: i64,
    request_id: String,
    /// The upstream that served the call, when it still exists.
    upstream: Option<Upstream>,
}

async fn settle_user(state: &AppState, user: &User) -> Result<(), ApiError> {
    let pending = user_db(state, user, false, |connection| {
        let upstreams = upstreams::load_all(connection)?
            .into_iter()
            .map(|upstream| (upstream.id.clone(), upstream))
            .collect::<HashMap<_, _>>();
        let mut statement = connection.prepare(
            "SELECT id,request_id,upstream_id FROM reasoning_audits
              WHERE cost_usd_nanos IS NULL AND request_id IS NOT NULL
                AND upstream_id IS NOT NULL AND status <> 'in_flight'
                AND finished_at IS NOT NULL AND finished_at > ? AND cost_attempts < ?
              ORDER BY id DESC LIMIT ?",
        )?;
        let rows = statement
            .query_map(
                params![now() - LOOKBACK_SECONDS, MAX_ATTEMPTS, SCAN_LIMIT],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .map(|(audit_id, request_id, upstream_id)| PendingCall {
                audit_id,
                request_id,
                upstream: upstreams.get(&upstream_id).cloned(),
            })
            .collect::<Vec<_>>())
    })
    .await?;
    if pending.is_empty() {
        return Ok(());
    }

    let mut settled: HashMap<i64, i64> = HashMap::new();
    let mut unsettled: Vec<i64> = Vec::new();
    let mut groups: HashMap<String, (Upstream, Vec<PendingCall>)> = HashMap::new();
    for call in pending {
        match &call.upstream {
            Some(upstream) => groups
                .entry(upstream.id.clone())
                .or_insert_with(|| (upstream.clone(), Vec::new()))
                .1
                .push(call),
            // The upstream is gone, so no query can ever resolve the row: spend
            // an attempt so it leaves the scan instead of being asked forever.
            None => unsettled.push(call.audit_id),
        }
    }

    for (_, (upstream, calls)) in groups {
        for chunk in calls.chunks(QUERY_BATCH) {
            let ids = chunk
                .iter()
                .map(|call| call.request_id.clone())
                .collect::<Vec<_>>();
            let answer = match query_costs(state, &upstream, &ids).await {
                Ok(answer) => answer,
                Err(error) => {
                    tracing::warn!(upstream=%upstream.name,error,"request-cost query failed");
                    unsettled.extend(chunk.iter().map(|call| call.audit_id));
                    continue;
                }
            };
            for call in chunk {
                match answer.get(&call.request_id) {
                    // An answered amount is final.
                    Some(Some(cost_usd_nanos)) => {
                        settled.insert(call.audit_id, *cost_usd_nanos);
                    }
                    // Still settling, or not recorded yet: ask again later.
                    Some(None) | None => unsettled.push(call.audit_id),
                }
            }
        }
    }

    if settled.is_empty() && unsettled.is_empty() {
        return Ok(());
    }
    user_db(state, user, false, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (audit_id, cost_usd_nanos) in settled {
            transaction.execute(
                "UPDATE reasoning_audits SET cost_usd_nanos=? WHERE id=? AND cost_usd_nanos IS NULL",
                params![cost_usd_nanos, audit_id],
            )?;
        }
        for audit_id in unsettled {
            transaction.execute(
                "UPDATE reasoning_audits SET cost_attempts=cost_attempts+1 WHERE id=?",
                [audit_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
}

/// Asks one upstream what the given request IDs cost. `Some(amount)` is a
/// settled answer, `None` a record the upstream holds but has not priced yet;
/// IDs absent from the answer were never recorded there.
async fn query_costs(
    state: &AppState,
    upstream: &Upstream,
    ids: &[String],
) -> Result<HashMap<String, Option<i64>>, String> {
    let response = state
        .client
        .post(format!(
            "{}/requests/query",
            upstream.base_url.trim_end_matches('/')
        ))
        .bearer_auth(upstream.api_key.as_str())
        .json(&json!({"ids": ids}))
        .timeout(QUERY_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let body: Value = response.json().await.map_err(|error| error.to_string())?;
    let mut answer = HashMap::new();
    if let Some(records) = body.get("requests").and_then(Value::as_array) {
        for record in records {
            let Some(request_id) = record.get("request_id").and_then(Value::as_str) else {
                continue;
            };
            answer.insert(
                request_id.to_owned(),
                record
                    .get("cost_usd_nanos")
                    .and_then(Value::as_i64)
                    .filter(|cost| *cost >= 0),
            );
        }
    }
    Ok(answer)
}
