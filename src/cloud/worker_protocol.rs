use super::*;
use std::collections::VecDeque;

pub(super) const BOOT_HEADER: &str = "x-cybion-worker-boot-id";

pub(super) fn boot_header(headers: &HeaderMap) -> Result<Option<String>, ApiError> {
    let Some(value) = headers.get(BOOT_HEADER) else {
        return Ok(None);
    };
    let value = value
        .to_str()
        .map_err(|_| ApiError::bad_request("invalid Worker boot ID"))?;
    if value.is_empty() {
        return Ok(None);
    }
    Uuid::parse_str(value).map_err(|_| ApiError::bad_request("invalid Worker boot ID"))?;
    Ok(Some(value.to_owned()))
}

pub(super) fn allow_report(
    c: &Connection,
    worker: &str,
    boot: Option<&str>,
) -> Result<(), ApiError> {
    let current: Option<String> =
        c.query_row("SELECT boot_id FROM workers WHERE id=?", [worker], |r| {
            r.get(0)
        })?;
    if current
        .as_deref()
        .is_some_and(|current| Some(current) != boot)
    {
        return Err(ApiError::conflict("report from an obsolete Worker process"));
    }
    Ok(())
}

// Doctor authenticates without claiming to be the running Worker process.
pub(super) fn liveness_report_is_current(
    c: &Connection,
    worker: &str,
    boot: Option<&str>,
) -> Result<bool, ApiError> {
    let current: Option<String> =
        c.query_row("SELECT boot_id FROM workers WHERE id=?", [worker], |r| {
            r.get(0)
        })?;
    if current.is_some() && boot.is_none() {
        return Ok(false);
    }
    allow_report(c, worker, boot)?;
    Ok(true)
}

fn register(
    c: &mut Connection,
    worker: &str,
    boot: Option<&str>,
    version: Option<&str>,
) -> Result<VecDeque<String>, ApiError> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: Option<String> =
        tx.query_row("SELECT boot_id FROM workers WHERE id=?", [worker], |r| {
            r.get(0)
        })?;
    // COMPATIBILITY: 0.1.x Workers may continue single-delivery operation during
    // the 0.2.0 rollout. Never replay their calls. Remove once the supported
    // minimum is 0.2.0 and all NULL-boot delivered calls have been settled.
    if boot.is_none() {
        if current.is_some() {
            return Err(ApiError::conflict("install Worker 0.2.0 or newer"));
        }
        return Ok(VecDeque::new());
    }
    if current.as_deref() != boot {
        let lost = {
            let mut q=tx.prepare("SELECT id,thread_id,input_record_id,responses_call_id,responses_output_type FROM worker_calls WHERE worker_id=? AND status='delivered' AND worker_boot_id IS NOT ?")?;
            q.query_map(params![worker, boot], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, thread, input, call, output_type) in lost {
            let message = "Worker restarted; its result was lost. The operation may already have happened; verify before repeating side effects.";
            let result =
                json!({"error":message,"code":"worker_restarted","execution_outcome":"unknown"});
            let superseded = input
                .map(|input| request_superseded(&tx, &thread, input))
                .transpose()?
                .unwrap_or(true);
            let output = json!({"type":output_type,"call_id":call,"output":result.to_string()});
            let output_id = persist_history_record(
                &tx,
                HistoryRecordInsert {
                    thread_id: &thread,
                    kind: if superseded {
                        "activity"
                    } else {
                        "tool_output"
                    },
                    payload: &output,
                    created_at: now(),
                },
            )?;
            tx.execute("UPDATE worker_calls SET status='failed',error=?,completed_at=?,output_record_id=? WHERE id=?",params![message,now(),output_id,id])?;
        }
        tx.execute(
            "UPDATE workers SET boot_id=? WHERE id=?",
            params![boot, worker],
        )?;
    }
    if let Some(version) = version {
        if semver(version).is_none() {
            return Err(ApiError::bad_request("invalid Worker version"));
        }
        if current.as_deref() != boot {
            tx.execute("UPDATE workers SET upgrade_status='failed',upgrade_error='Worker restarted without the requested version; previous executable may have been restored' WHERE id=? AND upgrade_status='installing' AND ltrim(upgrade_version,'v')!=ltrim(?,'v')",params![worker,version])?;
        }
        tx.execute(
            "UPDATE workers SET version=?,last_seen_at=?,status='online' WHERE id=?",
            params![version, now(), worker],
        )?;
        tx.execute("UPDATE workers SET upgrade_status='completed',upgrade_error=NULL WHERE id=? AND ltrim(upgrade_version,'v')=ltrim(version,'v')",[worker])?;
    }
    let replay = {
        let mut q=tx.prepare("SELECT id FROM worker_calls WHERE worker_id=? AND status='delivered' AND worker_boot_id=? ORDER BY created_at,id")?;
        q.query_map(params![worker, boot], |r| r.get(0))?
            .collect::<rusqlite::Result<VecDeque<String>>>()?
    };
    tx.commit()?;
    Ok(replay)
}

fn replay(
    c: &Connection,
    worker: &str,
    boot: Option<&str>,
    id: &str,
) -> Result<Option<WorkerCall>, ApiError> {
    Ok(c.query_row("SELECT id,thread_id,input_record_id,name,arguments_json FROM worker_calls WHERE id=? AND worker_id=? AND status='delivered' AND worker_boot_id=?",params![id,worker,boot],call_row).optional()?)
}
fn call_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkerCall> {
    let arguments: String = r.get(4)?;
    Ok(WorkerCall {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        input_record_id: r.get(2)?,
        name: r.get(3)?,
        arguments: serde_json::from_str(&arguments).map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}

pub(super) fn claim(
    c: &mut Connection,
    worker: &str,
    boot: Option<&str>,
) -> Result<Option<WorkerCall>, ApiError> {
    allow_report(c, worker, boot)?;
    let upgrading: bool = c.query_row(
        "SELECT COALESCE(upgrade_status IN ('queued','installing'),0) FROM workers WHERE id=?",
        [worker],
        |r| r.get(0),
    )?;
    if upgrading {
        return Ok(None);
    }
    if let Some(check) = worker_onboarding::claim_check(c, worker)? {
        return Ok(Some(check));
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    allow_report(&tx, worker, boot)?;
    let upgrading: bool = tx.query_row(
        "SELECT COALESCE(upgrade_status IN ('queued','installing'),0) FROM workers WHERE id=?",
        [worker],
        |r| r.get(0),
    )?;
    if upgrading {
        return Ok(None);
    }

    let call=tx.query_row("SELECT id,thread_id,input_record_id,name,arguments_json FROM worker_calls WHERE worker_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",[worker],call_row).optional()?;
    if let Some(call) = &call {
        tx.execute(
            "UPDATE worker_calls SET status='delivered',started_at=?,worker_boot_id=? WHERE id=?",
            params![now(), boot, call.id],
        )?;
    }
    tx.commit()?;
    Ok(call)
}

pub(super) async fn events(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((_user, worker)): AxumPath<(String, String)>,
    axum::Extension(user): axum::Extension<User>,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let worker = record_id(&worker)?;
    let boot = boot_header(&headers)?;
    let version = headers
        .get("x-cybion-worker-version")
        .map(|h| h.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| ApiError::bad_request("invalid Worker version"))?;
    let mut replay_ids = user_db(&state, &user, false, {
        let worker = worker.clone();
        let boot = boot.clone();
        move |c| register(c, &worker, boot.as_deref(), version.as_deref())
    })
    .await?;
    let stream = async_stream::stream! {
        loop {
            let result=user_db(&state,&user,false,{
                let worker=worker.clone();let boot=boot.clone();let id=replay_ids.pop_front();
                move |c| {
                    allow_report(c,&worker,boot.as_deref())?;
                    if let Some(id)=id {
                        return Ok(replay(c,&worker,boot.as_deref(),&id)?.map(|call|("tool_call",serde_json::to_value(call).expect("Worker call serializes"))));
                    }
                    if let Some(upgrade)=ready_upgrade(c,&worker,boot.as_deref())? {return Ok(Some(("upgrade",upgrade)));}
                    Ok(claim(c,&worker,boot.as_deref())?.map(|call|("tool_call",serde_json::to_value(call).expect("Worker call serializes"))))
                }
            }).await;
            match result {
                Ok(Some((name,payload))) => yield Ok(Event::default().event(name).data(payload.to_string())),
                Ok(None) => yield Ok(Event::default().event("heartbeat").data("{}")),
                Err(error) => {tracing::warn!(error=%error.message,"Worker event stream ended");break;}
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default()))
}

#[derive(Clone, Serialize)]
pub(super) struct UpgradeView {
    version: String,
    status: String,
    error: Option<String>,
}
pub(super) fn upgrade_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<UpgradeView>> {
    let version: Option<String> = row.get(8)?;
    version
        .map(|version| {
            Ok::<_, rusqlite::Error>(UpgradeView {
                version,
                status: row
                    .get::<_, Option<String>>(9)?
                    .unwrap_or_else(|| "queued".into()),
                error: row.get(10)?,
            })
        })
        .transpose()
}
fn recommended_version() -> String {
    serde_json::from_str::<Value>(include_str!("../../worker-release.json"))
        .expect("embedded release JSON")["version"]
        .as_str()
        .expect("release version")
        .to_owned()
}
fn semver(v: &str) -> Option<(u64, u64, u64)> {
    let p = v
        .trim_start_matches('v')
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if p.len() != 3 {
        return None;
    }
    Some((p[0], p[1], p[2]))
}

pub(super) async fn request_upgrade(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let id = record_id(&id)?;
    let target = recommended_version();
    user_db(&state, &identity.user, false, move |c| {
        queue_upgrade(c, &id, &target)
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}
fn queue_upgrade(c: &mut Connection, id: &str, target: &str) -> Result<(), ApiError> {
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    type UpgradeEligibility = (Option<String>, Option<String>, Option<String>, Option<i64>);
    let row: Option<UpgradeEligibility> = tx
        .query_row(
            "SELECT version,boot_id,upgrade_status,last_seen_at FROM workers WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((version, boot, status, seen)) = row else {
        return Err(ApiError::not_found("Worker not found"));
    };
    if boot.is_none() {
        return Err(ApiError::conflict(
            "Install Worker 0.2.0 manually once before using remote upgrades",
        ));
    }
    if seen.is_none_or(|at| at < now() - WORKER_ONLINE_SECONDS) {
        return Err(ApiError::conflict(
            "Worker must be online to request an upgrade",
        ));
    }
    let current = version
        .as_deref()
        .and_then(semver)
        .ok_or_else(|| ApiError::conflict("Worker has not reported a valid version"))?;
    if Some(current) >= semver(target) {
        return Err(ApiError::conflict(
            "Worker is already at or above the recommended version",
        ));
    }
    if status
        .as_deref()
        .is_some_and(|s| matches!(s, "queued" | "installing"))
    {
        return Ok(());
    }
    tx.execute("UPDATE workers SET upgrade_id=?,upgrade_version=?,upgrade_status='queued',upgrade_error=NULL WHERE id=?",params![Uuid::new_v4().to_string(),target,id])?;
    tx.commit()?;
    Ok(())
}
fn ready_upgrade(
    c: &Connection,
    worker: &str,
    boot: Option<&str>,
) -> Result<Option<Value>, ApiError> {
    let Some(boot) = boot else { return Ok(None) };
    let pending:Option<(String,String)>=c.query_row("SELECT upgrade_id,upgrade_version FROM workers WHERE id=? AND boot_id=? AND upgrade_status IN ('queued','installing') AND NOT EXISTS(SELECT 1 FROM worker_calls WHERE worker_id=? AND status='delivered') AND NOT EXISTS(SELECT 1 FROM worker_checks WHERE worker_id=? AND delivered_at IS NOT NULL AND completed_at IS NULL AND created_at>?)",params![worker,boot,worker,worker,now()-30],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    Ok(pending.map(|(id, version)| json!({"id":id,"version":version,"boot_id":boot})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpgradeResult {
    id: String,
    status: String,
    error: Option<String>,
}
pub(super) async fn upgrade_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((_owner, worker)): AxumPath<(String, String)>,
    axum::Extension(user): axum::Extension<User>,
    Json(input): Json<UpgradeResult>,
) -> Result<Json<Value>, ApiError> {
    if !matches!(input.status.as_str(), "installing" | "failed") {
        return Err(ApiError::bad_request("invalid upgrade status"));
    }
    let boot =
        boot_header(&headers)?.ok_or_else(|| ApiError::bad_request("Worker boot ID required"))?;
    user_db(&state,&user,false,move |c|{
        allow_report(c,&worker,Some(&boot))?;
        let changed=c.execute("UPDATE workers SET upgrade_status=?,upgrade_error=? WHERE id=? AND upgrade_id=? AND upgrade_status IN ('queued','installing','failed')",params![input.status,input.error.map(|e|truncate(&e,2048)),worker,input.id])?;
        if changed==0 {return Err(ApiError::conflict("upgrade request is no longer current"));} Ok(())
    }).await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests;
