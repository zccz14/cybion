//! Device-initiated pairing. The long-lived credential is generated on the device;
//! neither the browser nor the pairing store ever receives its plaintext.
use super::*;

const TTL: i64 = 600;
pub(super) const CHECK_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS worker_checks (
 id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, delivered_at INTEGER, completed_at INTEGER, result_json TEXT
);
CREATE INDEX IF NOT EXISTS worker_checks_worker ON worker_checks(worker_id,created_at DESC);
";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartInput {
    device_secret: String,
    token_hash: String,
    hostname: String,
    platform: String,
    version: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct PairingView {
    id: String,
    user_code: String,
    hostname: String,
    platform: String,
    version: String,
    expires_at: i64,
    status: String,
    worker_id: String,
}

fn pairing_connection(path: &Path) -> Result<Connection, ApiError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS device_pairings (
      id TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL, hostname TEXT NOT NULL, platform TEXT NOT NULL, version TEXT NOT NULL,
      expires_at INTEGER NOT NULL, owner_id TEXT, worker_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', last_polled_at INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS pairing_limits (
      key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL
    );")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(ApiError::internal)?;
    }
    Ok(connection)
}

async fn pairing_db<T: Send + 'static>(
    state: &AppState,
    action: impl FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let path = state.data_dir.join("pairings.sqlite3");
    tokio::task::spawn_blocking(move || action(&mut pairing_connection(&path)?))
        .await
        .map_err(ApiError::internal)?
}

fn rate_limit(connection: &mut Connection, key: &str, max: i64) -> Result<(), ApiError> {
    let window = now() / 60;
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM pairing_limits WHERE window < ?", [window - 1])?;
    let count: i64 = tx.query_row(
        "INSERT INTO pairing_limits(key,window,count) VALUES(?,?,1)
         ON CONFLICT(key) DO UPDATE SET window=excluded.window,
         count=CASE WHEN pairing_limits.window=excluded.window THEN count+1 ELSE 1 END RETURNING count",
        params![key, window], |row| row.get(0))?;
    tx.commit()?;
    if count > max {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "Too many pairing attempts; retry in one minute".into(),
            kind: ApiErrorKind::Ordinary,
        });
    }
    Ok(())
}

fn hex_secret(value: &str) -> Result<(), ApiError> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "expected a 256-bit hexadecimal value",
        ));
    }
    Ok(())
}

fn code(value: &str) -> Result<String, ApiError> {
    let value = value.trim().replace(['-', ' '], "").to_uppercase();
    if value.len() != 12 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::bad_request(
            "Enter the 12-character code shown on your device",
        ));
    }
    Ok(format!("{}-{}-{}", &value[..4], &value[4..8], &value[8..]))
}

fn view(
    connection: &Connection,
    user_code: &str,
) -> Result<(PairingView, Option<String>), ApiError> {
    connection
        .query_row(
            "SELECT id,user_code,hostname,platform,version,expires_at,status,worker_id,owner_id
         FROM device_pairings WHERE user_code=?",
            [user_code],
            |row| {
                let expires: i64 = row.get(5)?;
                let status: String = row.get(6)?;
                Ok((
                    PairingView {
                        id: row.get(0)?,
                        user_code: row.get(1)?,
                        hostname: row.get(2)?,
                        platform: row.get(3)?,
                        version: row.get(4)?,
                        expires_at: expires,
                        status: if expires <= now() && status != "approved" {
                            "expired".into()
                        } else {
                            status
                        },
                        worker_id: row.get(7)?,
                    },
                    row.get(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            ApiError::not_found("Pairing not found; restart the Worker to obtain a new code")
        })
}

pub(super) async fn start(
    State(state): State<AppState>,
    Json(input): Json<StartInput>,
) -> Result<Json<Value>, ApiError> {
    hex_secret(&input.device_secret)?;
    hex_secret(&input.token_hash)?;
    let hostname = label(&input.hostname, "hostname", 80)?;
    let platform = label(&input.platform, "platform", 80)?;
    let version = label(&input.version, "version", 40)?;
    pairing_db(&state, move |connection| {
        rate_limit(connection, "start", 120)?;
        connection.execute("DELETE FROM device_pairings WHERE expires_at < ?", [now() - 86400])?;
        let id = Uuid::new_v4().to_string();
        let user_code = code(&Uuid::new_v4().simple().to_string()[..12])?;
        let expires_at = now() + TTL;
        connection.execute("INSERT INTO device_pairings(id,user_code,secret_hash,token_hash,hostname,platform,version,expires_at,worker_id)
            VALUES(?,?,?,?,?,?,?,?,?)", params![id,user_code,hash_secret(&input.device_secret),input.token_hash.to_lowercase(),hostname,platform,version,expires_at,Uuid::new_v4().to_string()])?;
        Ok(Json(json!({"id":id,"user_code":user_code,"expires_at":expires_at,"interval":3,
            "verification_uri": "https://cybion.ntnl.io/#/workers"})))
    }).await
}

pub(super) async fn poll(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let id = record_id(&id)?;
    let secret = bearer(&headers)?;
    hex_secret(&secret)?;
    pairing_db(&state, move |connection| {
        rate_limit(connection, "poll", 6000)?;
        let row: Option<(String,String,i64,Option<String>,String)> = connection.query_row(
            "SELECT status,worker_id,expires_at,owner_id,user_code FROM device_pairings WHERE id=? AND secret_hash=?",
            params![id,hash_secret(&secret)], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let (status, worker_id, expires, owner, _) = row.ok_or_else(|| ApiError::unauthorized("invalid device credential"))?;
        if expires <= now() { return Err(ApiError {status:StatusCode::GONE,message:"Pairing expired; restart the Worker".into(),kind:ApiErrorKind::Ordinary}); }
        let updated = connection.execute("UPDATE device_pairings SET last_polled_at=? WHERE id=? AND last_polled_at<=?", params![now(),id,now()-2])?;
        if updated == 0 { return Err(ApiError {status:StatusCode::TOO_MANY_REQUESTS,message:"Poll no faster than every 3 seconds".into(),kind:ApiErrorKind::Ordinary}); }
        Ok(Json(json!({"status":status,"user_id":owner,"machine_id":worker_id})))
    }).await
}

pub(super) async fn read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(value): AxumPath<String>,
) -> Result<Json<PairingView>, ApiError> {
    let code = code(&value)?;
    pairing_db(&state, move |connection| {
        rate_limit(connection, &format!("lookup:{}", identity.user.id), 60)?;
        let (view, owner) = view(connection, &code)?;
        if owner.is_some_and(|owner| owner != identity.user.id) {
            return Err(ApiError::not_found(
                "Pairing is already owned by another account",
            ));
        }
        Ok(Json(view))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ApproveInput {
    label: String,
}

pub(super) async fn approve(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(value): AxumPath<String>,
    Json(input): Json<ApproveInput>,
) -> Result<Json<PairingView>, ApiError> {
    let code = code(&value)?;
    let label = label(&input.label, "label", 80)?;
    let owner = identity.user.id.clone();
    let code_copy = code.clone();
    // Bind the owner durably before touching the tenant DB. A failed provisioning
    // can only be resumed by that same owner; approved/revoked devices are never recreated.
    let (pairing, token_hash) = pairing_db(&state, move |connection| {
        rate_limit(connection, &format!("approve:{owner}"), 30)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (pairing, existing_owner) = view(&tx, &code_copy)?;
        if existing_owner.is_some_and(|id| id != owner) {
            return Err(ApiError::forbidden("Pairing belongs to another account"));
        }
        if !matches!(
            pairing.status.as_str(),
            "pending" | "approving" | "approved"
        ) {
            return Err(ApiError::conflict(
                "Pairing expired or cancelled; restart the Worker",
            ));
        }
        if pairing.status == "approved" {
            return Ok((pairing, None));
        }
        tx.execute(
            "UPDATE device_pairings SET owner_id=?,status='approving' WHERE id=?",
            params![owner, pairing.id],
        )?;
        let token: String = tx.query_row(
            "SELECT token_hash FROM device_pairings WHERE id=?",
            [&pairing.id],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok((pairing, Some(token)))
    })
    .await?;
    if let Some(token_hash) = token_hash {
        let worker_id = pairing.worker_id.clone();
        user_db(&state, &identity.user, true, move |connection| {
            connection.execute("INSERT INTO workers(id,label,token_hash,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING", params![worker_id,label,token_hash,now()])?;
            Ok(())
        }).await?;
        let id = pairing.id.clone();
        pairing_db(&state, move |connection| {
            connection.execute(
                "UPDATE device_pairings SET status='approved',expires_at=? WHERE id=? AND status='approving'",
                params![now()+TTL,id],
            )?;
            Ok(())
        })
        .await?;
    }
    read(State(state), axum::Extension(identity), AxumPath(code)).await
}

pub(super) async fn cancel(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(value): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let code = code(&value)?;
    pairing_db(&state, move |connection| {
        rate_limit(connection, &format!("approve:{}",identity.user.id), 30)?;
        let changed = connection.execute("UPDATE device_pairings SET status='cancelled',owner_id=? WHERE user_code=? AND status='pending' AND expires_at>?", params![identity.user.id,code,now()])?;
        if changed == 0 { return Err(ApiError::conflict("Pairing is no longer pending; remove the device to revoke an approved connection")); }
        Ok(StatusCode::NO_CONTENT)
    }).await
}

pub(super) async fn release() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!("../../worker-release.json"))
            .expect("release manifest is validated in tests"),
    )
}

#[derive(Serialize, Deserialize)]
pub(super) struct CheckView {
    id: String,
    worker_id: String,
    status: String,
    created_at: i64,
    completed_at: Option<i64>,
    result: Option<Value>,
}

fn latest_check(connection: &Connection, worker_id: &str) -> Result<Option<CheckView>, ApiError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workers WHERE id=?)",
        [worker_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ApiError::not_found("Worker not found"));
    }
    Ok(connection.query_row("SELECT id,created_at,delivered_at,completed_at,result_json FROM worker_checks WHERE worker_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", [worker_id], |row| {
        let created_at: i64 = row.get(1)?;
        let completed_at: Option<i64> = row.get(3)?;
        let delivered: Option<i64> = row.get(2)?;
        let result: Option<String> = row.get(4)?;
        Ok(CheckView { id:row.get(0)?,worker_id:worker_id.to_owned(),created_at,completed_at,
            status: if completed_at.is_some() {"completed"} else if created_at+30<=now() {"timed_out"} else if delivered.is_some() {"delivered"} else {"queued"}.into(),
            result:result.map(|v| serde_json::from_str(&v)).transpose().map_err(|err| rusqlite::Error::FromSqlConversionFailure(4,rusqlite::types::Type::Text,Box::new(err)))? })
    }).optional()?)
}

pub(super) async fn check_read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(worker_id): AxumPath<String>,
) -> Result<Json<Option<CheckView>>, ApiError> {
    let id = record_id(&worker_id)?;
    Ok(Json(
        user_db(&state, &identity.user, true, move |c| latest_check(c, &id)).await?,
    ))
}

pub(super) async fn check_start(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(worker_id): AxumPath<String>,
) -> Result<Json<Option<CheckView>>, ApiError> {
    let id = record_id(&worker_id)?;
    Ok(Json(
        user_db(&state, &identity.user, true, move |connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some(check) = latest_check(&tx, &id)?
                && check.created_at + 30 > now()
            {
                return Ok(Some(check));
            }
            let version: Option<String> =
                tx.query_row("SELECT version FROM workers WHERE id=?", [&id], |r| {
                    r.get(0)
                })?;
            // COMPATIBILITY: maintained by Cybion. Pre-0.1.4 Workers cannot dispatch
            // diagnostics. Remove this guard only when the supported minimum is 0.1.4
            // and stored/active Worker versions have been audited; keep a version test.
            if !version.as_deref().is_some_and(supports_checks) {
                return Err(ApiError::conflict(
                    "Connect Worker v0.1.4 or newer before running diagnostics",
                ));
            }
            tx.execute("DELETE FROM worker_checks WHERE worker_id=?", [&id])?;
            tx.execute(
                "INSERT INTO worker_checks(id,worker_id,created_at) VALUES(?,?,?)",
                params![Uuid::new_v4().to_string(), id, now()],
            )?;
            let check = latest_check(&tx, &id)?;
            tx.commit()?;
            Ok(check)
        })
        .await?,
    ))
}

fn supports_checks(version: &str) -> bool {
    let parts: Vec<_> = version
        .trim_start_matches('v')
        .split('.')
        .map(str::parse::<u64>)
        .collect();
    matches!(parts.as_slice(), [Ok(major),Ok(minor),Ok(patch)] if (*major,*minor,*patch)>=(0,1,4))
}

pub(super) fn claim_check(
    connection: &mut Connection,
    worker_id: &str,
) -> Result<Option<WorkerCall>, ApiError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM workers WHERE id=?)",
        [worker_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ApiError::unauthorized("Worker was revoked"));
    }
    let id: Option<String> = connection.query_row("UPDATE worker_checks SET delivered_at=? WHERE id=(SELECT id FROM worker_checks WHERE worker_id=? AND delivered_at IS NULL AND created_at>? ORDER BY created_at LIMIT 1) RETURNING id",params![now(),worker_id,now()-30],|r| r.get(0)).optional()?;
    Ok(id.map(|id| WorkerCall {
        id,
        thread_id: String::new(),
        input_record_id: None,
        name: "diagnostics".into(),
        arguments: json!({}),
    }))
}

pub(super) async fn check_result(
    State(state): State<AppState>,
    axum::Extension(user): axum::Extension<User>,
    AxumPath((_user_id, worker_id, id)): AxumPath<(String, String, String)>,
    Json(input): Json<WorkerResultInput>,
) -> Result<Json<Value>, ApiError> {
    let worker_id = record_id(&worker_id)?;
    let id = record_id(&id)?;
    let serialized = serde_json::to_string(&input.result).map_err(ApiError::internal)?;
    if serialized.len() > 16384 {
        return Err(ApiError::bad_request("diagnostic result too large"));
    }
    user_db(&state,&user,false,move |c| {
        let changed = c.execute("UPDATE worker_checks SET completed_at=?,result_json=? WHERE id=? AND worker_id=? AND delivered_at IS NOT NULL AND completed_at IS NULL AND created_at>?",params![now(),serialized,id,worker_id,now()-30])?;
        if changed==0 {return Err(ApiError::conflict("diagnostic check expired, completed, or not delivered to this Worker"));}
        Ok(())
    }).await?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests;
