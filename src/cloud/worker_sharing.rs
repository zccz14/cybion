use super::*;

const BATCH: i64 = 32;

pub(super) fn migrate(c: &Connection) -> Result<(), ApiError> {
    // Preserve the exact legacy columns, including boot receipts and result bytes.
    // Foreign thread/history IDs belong to the caller, never the owner database.
    let sql: String = c.query_row(
        "SELECT sql FROM sqlite_schema WHERE name='worker_calls'",
        [],
        |r| r.get(0),
    )?;
    let columns = {
        let mut q = c.prepare("PRAGMA table_info(worker_calls)")?;
        q.query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .join(",")
    };
    let indexes = {
        let mut q = c.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='worker_calls' AND sql IS NOT NULL")?;
        q.query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let sql = sql
        .replacen("worker_calls", "worker_calls_shared", 1)
        .replace(" REFERENCES threads(id) ON DELETE CASCADE", "")
        .replace(" REFERENCES history_records(id) ON DELETE SET NULL", "")
        .replace(
            " REFERENCES workers(id) ON DELETE CASCADE",
            " REFERENCES workers(id)",
        );
    c.execute_batch(&sql)?;
    c.execute_batch(&format!("INSERT INTO worker_calls_shared({columns}) SELECT {columns} FROM worker_calls; DROP TABLE worker_calls; ALTER TABLE worker_calls_shared RENAME TO worker_calls;"))?;
    for sql in indexes {
        c.execute_batch(&sql)?;
    }
    c.execute_batch(r#"
ALTER TABLE workers ADD COLUMN deleted_at INTEGER;
ALTER TABLE worker_calls ADD COLUMN caller_user_id TEXT;
ALTER TABLE worker_calls ADD COLUMN grant_id TEXT;
ALTER TABLE worker_calls ADD COLUMN delivery_attempted_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_calls ADD COLUMN dispatch_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_calls ADD COLUMN output_discarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_calls ADD COLUMN late_output_record_id INTEGER;
ALTER TABLE worker_calls ADD COLUMN failure_code TEXT;
ALTER TABLE worker_calls ADD COLUMN late_result INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_calls ADD COLUMN late_output_discarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE history_records ADD COLUMN worker_owner_user_id TEXT;
ALTER TABLE history_records ADD COLUMN worker_grant_id TEXT;
ALTER TABLE history_records ADD COLUMN worker_call_id TEXT;
ALTER TABLE history_records ADD COLUMN worker_input_id INTEGER;
ALTER TABLE history_records ADD COLUMN worker_output_phase TEXT;
ALTER TABLE history_records ADD COLUMN worker_screenshot INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX history_worker_origin ON history_records(worker_owner_user_id,worker_call_id,worker_output_phase) WHERE worker_output_phase IS NOT NULL;
CREATE INDEX history_worker_intent ON history_records(worker_call_id) WHERE worker_call_id IS NOT NULL AND worker_output_phase IS NULL;
CREATE UNIQUE INDEX worker_calls_foreign_origin ON worker_calls(caller_user_id,thread_id,input_record_id,responses_call_id) WHERE caller_user_id IS NOT NULL;
CREATE INDEX worker_calls_queued ON worker_calls(worker_id,MAX(created_at,dispatch_retry_at),created_at,id) WHERE status='queued';
CREATE INDEX worker_calls_pending_output ON worker_calls(delivery_attempted_at,created_at,id) WHERE caller_user_id IS NOT NULL AND status IN ('completed','failed') AND ((output_record_id IS NULL AND output_discarded=0) OR (late_result=1 AND result_json IS NOT NULL AND late_output_record_id IS NULL AND late_output_discarded=0));
CREATE INDEX worker_calls_created ON worker_calls(created_at DESC,id DESC);
CREATE INDEX worker_calls_status_created ON worker_calls(status,created_at DESC,id DESC);
CREATE INDEX worker_calls_worker_created ON worker_calls(worker_id,created_at DESC,id DESC);
CREATE TABLE worker_grants (
 worker_id TEXT NOT NULL REFERENCES workers(id), grantee_user_id TEXT NOT NULL,
 grant_id TEXT NOT NULL, revoked_at INTEGER, revision INTEGER NOT NULL,
 synced_revision INTEGER NOT NULL DEFAULT 0, sync_attempted_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(worker_id,grantee_user_id));
CREATE INDEX worker_grants_unsynced ON worker_grants(sync_attempted_at,updated_at,worker_id,grantee_user_id) WHERE revision>synced_revision;
CREATE TABLE shared_workers (
 owner_user_id TEXT NOT NULL, worker_id TEXT NOT NULL, label TEXT NOT NULL,
 grant_id TEXT NOT NULL, revoked_at INTEGER, revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user_id,worker_id));
"#)?;
    check_user_foreign_keys(c)
}

fn sibling(c: &Connection, id: &str) -> Result<PathBuf, ApiError> {
    let id = user_id(id)?;
    let path = c
        .path()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| ApiError::unavailable("caller database unavailable"))?;
    Ok(Path::new(path)
        .parent()
        .ok_or_else(|| ApiError::internal("missing user directory"))?
        .join(format!("{id}.sqlite3")))
}

fn read_caller(c: &Connection, caller: &str) -> Result<Connection, ApiError> {
    let b = Connection::open_with_flags(
        sibling(c, caller)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    b.busy_timeout(Duration::from_millis(100))?;
    let version: i64 = b.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != USER_SCHEMA_VERSION {
        return Err(ApiError::unavailable("caller schema unavailable"));
    }
    Ok(b)
}

fn open_projection(c: &Connection, recipient: &str) -> Result<Connection, ApiError> {
    // Short per-recipient lock budget keeps an unavailable recipient from
    // occupying the recovery pass for the ordinary five-second DB timeout.
    let mut b = Connection::open_with_flags(
        sibling(c, recipient)?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    b.busy_timeout(Duration::from_millis(100))?;
    ensure_user_schema(&mut b)?;
    Ok(b)
}

fn require_owner(c: &Connection, worker: &str) -> Result<(), ApiError> {
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM workers WHERE id=? AND deleted_at IS NULL)",
        [worker],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(ApiError::not_found("owned Worker not found"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct Grant {
    grantee_user_id: String,
    grant_id: String,
    revoked_at: Option<i64>,
    revision: i64,
    synced_revision: i64,
    created_at: i64,
    updated_at: i64,
}
fn grant_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    Ok(Grant {
        grantee_user_id: r.get(0)?,
        grant_id: r.get(1)?,
        revoked_at: r.get(2)?,
        revision: r.get(3)?,
        synced_revision: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}
const GRANT_COLUMNS: &str =
    "grantee_user_id,grant_id,revoked_at,revision,synced_revision,created_at,updated_at";
fn get_grant(c: &Connection, worker: &str, grantee: &str) -> Result<Grant, ApiError> {
    Ok(c.query_row(
        &format!(
            "SELECT {GRANT_COLUMNS} FROM worker_grants WHERE worker_id=? AND grantee_user_id=?"
        ),
        params![worker, grantee],
        grant_row,
    )?)
}

fn change_grant(
    c: &mut Connection,
    owner: &str,
    worker: &str,
    grantee: &str,
    revoke: bool,
) -> Result<(), ApiError> {
    let grantee = user_id(grantee)?;
    let grantee = grantee.as_str();
    if owner == grantee {
        return Err(ApiError::bad_request("cannot grant a Worker to yourself"));
    }
    require_owner(c, worker)?;
    if !revoke {
        let _ = read_caller(c, grantee)?;
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    require_owner(&tx, worker)?;
    if revoke {
        tx.execute("UPDATE worker_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE worker_id=? AND grantee_user_id=? AND revoked_at IS NULL",params![now(),now(),worker,grantee])?;
        tx.execute("UPDATE worker_calls SET status='failed',error='Worker grant revoked',completed_at=? WHERE worker_id=? AND caller_user_id=? AND status='queued'",params![now(),worker,grantee])?;
    } else {
        tx.execute("INSERT INTO worker_grants(worker_id,grantee_user_id,grant_id,revision,created_at,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(worker_id,grantee_user_id) DO UPDATE SET grant_id=excluded.grant_id,revoked_at=NULL,revision=worker_grants.revision+1,updated_at=excluded.updated_at WHERE worker_grants.revoked_at IS NOT NULL",params![worker,grantee,Uuid::new_v4().to_string(),now(),now()])?;
    }
    tx.commit()?;
    Ok(())
}

fn sync_grants(c: &Connection, owner: &str) -> Result<(), ApiError> {
    let rows = {
        let mut q=c.prepare("SELECT g.worker_id,w.label,g.grantee_user_id,g.grant_id,g.revoked_at,g.revision,g.created_at,g.updated_at FROM worker_grants g JOIN workers w ON w.id=g.worker_id WHERE g.revision>g.synced_revision ORDER BY g.sync_attempted_at,g.updated_at,g.worker_id,g.grantee_user_id LIMIT ?")?;
        q.query_map([BATCH], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (worker, label, grantee, grant, revoked, revision, created, updated) in rows {
        let result = (|| -> Result<(), ApiError> {
            c.execute("UPDATE worker_grants SET sync_attempted_at=? WHERE worker_id=? AND grantee_user_id=?",params![now(),worker,grantee])?;
            let b = open_projection(c, &grantee)?;
            b.execute("INSERT INTO shared_workers(owner_user_id,worker_id,label,grant_id,revoked_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,worker_id) DO UPDATE SET label=excluded.label,grant_id=excluded.grant_id,revoked_at=excluded.revoked_at,revision=excluded.revision,updated_at=excluded.updated_at WHERE excluded.revision>shared_workers.revision",params![owner,worker,label,grant,revoked,revision,created,updated])?;
            c.execute("UPDATE worker_grants SET synced_revision=? WHERE worker_id=? AND grantee_user_id=? AND revision=?",params![revision,worker,grantee,revision])?;
            Ok(())
        })();
        if let Err(e) = result {
            tracing::warn!(error=%e.message,"Worker grant discovery sync deferred");
        }
    }
    Ok(())
}

pub(super) async fn list_grants(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(worker): AxumPath<String>,
) -> Result<Json<Vec<Grant>>, ApiError> {
    user_db(&state, &identity.user, false, move |c| {
        require_owner(c, &worker)?;
        let mut q = c.prepare(&format!(
            "SELECT {GRANT_COLUMNS} FROM worker_grants WHERE worker_id=? ORDER BY grantee_user_id"
        ))?;
        Ok(q.query_map([worker], grant_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .await
    .map(Json)
}
pub(super) async fn grant(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((worker, grantee)): AxumPath<(String, String)>,
) -> Result<Json<Grant>, ApiError> {
    let grantee = user_id(&grantee)?;
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        change_grant(c, &owner, &worker, &grantee, false)?;
        sync_grants(c, &owner)?;
        get_grant(c, &worker, &grantee)
    })
    .await
    .map(Json)
}
pub(super) async fn revoke(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((worker, grantee)): AxumPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let grantee = user_id(&grantee)?;
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        change_grant(c, &owner, &worker, &grantee, true)?;
        sync_grants(c, &owner)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn views(c: &Connection, owner: &str) -> Result<Vec<WorkerView>, ApiError> {
    let mut q=c.prepare("SELECT id,label,created_at,last_seen_at,CASE WHEN last_seen_at>=? THEN 'online' ELSE 'offline' END,resource_json,version,boot_id,upgrade_version,upgrade_status,upgrade_error FROM workers WHERE deleted_at IS NULL ORDER BY created_at DESC")?;
    let mut rows = q
        .query_map([now() - WORKER_ONLINE_SECONDS], |r| {
            Ok(WorkerView {
                owner_user_id: owner.to_owned(),
                access: "owner".into(),
                id: r.get(0)?,
                label: r.get(1)?,
                created_at: r.get(2)?,
                last_seen_at: r.get(3)?,
                status: r.get(4)?,
                resource: r
                    .get::<_, Option<String>>(5)?
                    .and_then(|v| serde_json::from_str(&v).ok()),
                version: r.get(6)?,
                can_upgrade: r.get::<_, Option<String>>(7)?.is_some(),
                upgrade: worker_protocol::upgrade_view(r)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut q=c.prepare("SELECT owner_user_id,worker_id,label,created_at FROM shared_workers WHERE revoked_at IS NULL ORDER BY label,worker_id")?;
    rows.extend(
        q.query_map([], |r| {
            Ok(WorkerView {
                owner_user_id: r.get(0)?,
                access: "shared".into(),
                id: r.get(1)?,
                label: r.get(2)?,
                created_at: r.get(3)?,
                last_seen_at: None,
                status: "unknown".into(),
                resource: None,
                version: None,
                can_upgrade: false,
                upgrade: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    Ok(rows)
}
pub(super) async fn list_workers(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<Vec<WorkerView>>, ApiError> {
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, true, move |c| views(c, &owner))
        .await
        .map(Json)
}
pub(super) async fn read_worker(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<WorkerView>, ApiError> {
    let caller = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        let mut found = views(c, &caller)?
            .into_iter()
            .filter(|w| w.id == id)
            .collect::<Vec<_>>();
        if found.len() != 1 {
            return Err(ApiError::not_found("Worker not found or ambiguous"));
        }
        let view = found.remove(0);
        if view.access == "shared" {
            let grant: String = c.query_row(
                "SELECT grant_id FROM shared_workers WHERE owner_user_id=? AND worker_id=?",
                params![view.owner_user_id, id],
                |r| r.get(0),
            )?;
            let a = open_user(&sibling(c, &view.owner_user_id)?, false)?;
            authorize(&a, &id, &caller, &grant)?;
        }
        Ok(view)
    })
    .await
    .map(Json)
}
pub(super) async fn update_worker(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<UpdateWorkerInput>,
) -> Result<Json<WorkerView>, ApiError> {
    let label = label(&input.label, "label", 80)?;
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_owner(&tx, &id)?;
        tx.execute("UPDATE workers SET label=? WHERE id=?", params![label, id])?;
        tx.execute(
            "UPDATE worker_grants SET revision=revision+1,updated_at=? WHERE worker_id=?",
            params![now(), id],
        )?;
        tx.commit()?;
        sync_grants(c, &owner)?;
        views(c, &owner)?
            .into_iter()
            .find(|v| v.access == "owner" && v.id == id)
            .ok_or_else(|| ApiError::not_found("Worker not found"))
    })
    .await
    .map(Json)
}
pub(super) async fn delete_worker(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let _lock = state.worker_pairing_lock.lock().await;
    worker_onboarding::revoke_pairing(&state, &identity.user.id, &id).await?;
    let owner = identity.user.id.clone();
    user_db(&state,&identity.user,false,move|c| {
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;require_owner(&tx,&id)?;
        tx.execute("UPDATE workers SET deleted_at=?,status='offline' WHERE id=?",params![now(),id])?;
        tx.execute("UPDATE worker_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE worker_id=?",params![now(),now(),id])?;
        tx.execute("UPDATE worker_calls SET status='failed',error='Worker deleted',completed_at=? WHERE worker_id=? AND status='queued'",params![now(),id])?;
        tx.commit()?;sync_grants(c,&owner)
    }).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn grant_active(c: &Connection, worker: &str, caller: &str, grant: &str) -> Result<bool, ApiError> {
    let ok:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM worker_grants g JOIN workers w ON w.id=g.worker_id WHERE g.worker_id=? AND g.grantee_user_id=? AND g.grant_id=? AND g.revoked_at IS NULL AND w.deleted_at IS NULL)",params![worker,caller,grant],|r|r.get(0))?;
    Ok(ok)
}

fn authorize(c: &Connection, worker: &str, caller: &str, grant: &str) -> Result<(), ApiError> {
    if !grant_active(c, worker, caller, grant)? {
        return Err(ApiError::conflict("Worker grant is no longer active"));
    }
    Ok(())
}

fn audit_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkerCallAuditView> {
    Ok(WorkerCallAuditView {
        id: r.get(0)?,
        worker_id: r.get(1)?,
        worker_label: r.get(2)?,
        worker_hostname: r.get(3)?,
        worker_version: r.get(4)?,
        worker_resource: r
            .get::<_, Option<String>>(5)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        thread_id: r.get(6)?,
        thread_title: r.get(7)?,
        input_record_id: r.get(8)?,
        name: r.get(9)?,
        arguments: r
            .get::<_, Option<String>>(10)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null),
        status: r.get(11)?,
        result: r
            .get::<_, Option<String>>(12)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        error: r.get(13)?,
        created_at: r.get(14)?,
        started_at: r.get(15)?,
        completed_at: r.get(16)?,
        received_at: r.get(17)?,
        caller_user_id: r.get(18)?,
        has_details: true,
    })
}
fn audit_select(detail: bool) -> String {
    let (resource, args, result) = if detail {
        (
            "c.worker_resource_json",
            "c.arguments_json",
            "c.result_json",
        )
    } else {
        ("NULL", "NULL", "NULL")
    };
    let error = if detail {
        "c.error"
    } else {
        "substr(c.error,1,1024)"
    };
    format!(
        "SELECT c.id,c.worker_id,c.worker_label,c.worker_hostname,c.worker_version,{resource},c.thread_id,COALESCE(t.title,''),c.input_record_id,c.name,{args},c.status,{result},{error},c.created_at,c.started_at,c.completed_at,c.received_at,COALESCE(c.caller_user_id,?1) FROM worker_calls c LEFT JOIN threads t ON c.caller_user_id IS NULL AND t.id=c.thread_id"
    )
}
pub(super) async fn worker_call_audits(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Query(query): Query<WorkerCallAuditQuery>,
) -> Result<Json<WorkerCallAuditPage>, ApiError> {
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, true, move |c| {
        audit_page(c, &owner, query)
    })
    .await
    .map(Json)
}
fn audit_page(
    c: &Connection,
    owner: &str,
    query: WorkerCallAuditQuery,
) -> Result<WorkerCallAuditPage, ApiError> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(20).clamp(1, 100);
    let mut values = vec![rusqlite::types::Value::Text(owner.into())];
    let mut filters = Vec::new();
    for (column, value) in [
        ("status", query.status),
        ("worker_id", query.worker_id),
        ("thread_id", query.thread_id),
    ] {
        if let Some(value) = value.filter(|s| !s.trim().is_empty()) {
            if column == "status"
                && !matches!(
                    value.as_str(),
                    "queued" | "delivered" | "completed" | "failed"
                )
            {
                return Err(ApiError::bad_request("invalid Worker call status"));
            }
            values.push(value.into());
            filters.push(format!("c.{column}=?{}", values.len()));
            if column == "thread_id" {
                filters.push("c.caller_user_id IS NULL".to_owned());
            }
        }
    }
    // ?1 is shared with the view's owner fallback. Keep it bound in count too.
    let filter = format!(
        " WHERE ?1 IS NOT NULL{}",
        if filters.is_empty() {
            String::new()
        } else {
            format!(" AND {}", filters.join(" AND "))
        }
    );
    let total = c.query_row(
        &format!("SELECT COUNT(*) FROM worker_calls c{filter}"),
        rusqlite::params_from_iter(&values),
        |r| r.get(0),
    )?;
    let select = format!(
        "{}{filter} ORDER BY c.created_at DESC,c.id DESC LIMIT ?{} OFFSET ?{}",
        audit_select(false),
        values.len() + 1,
        values.len() + 2
    );
    values.push((page_size as i64).into());
    values.push(((page - 1).saturating_mul(page_size).min(i64::MAX as usize) as i64).into());
    let mut q = c.prepare(&select)?;
    let items = q
        .query_map(rusqlite::params_from_iter(&values), audit_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(WorkerCallAuditPage {
        items,
        total,
        page,
        page_size,
    })
}
pub(super) async fn call_detail(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<WorkerCallAuditView>, ApiError> {
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        c.query_row(
            &format!("{} WHERE c.id=?2", audit_select(true)),
            params![owner, id],
            audit_row,
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("Worker call not found"))
    })
    .await
    .map(Json)
}

// Called within the history insertion transaction. These columns never enter
// Responses payloads. An empty owner is a durable rejected route, not a retry
// against a future grant. The local owner route is represented by NULL.
pub(super) fn bind_intent(
    c: &Connection,
    record: i64,
    thread: &str,
    input: i64,
    item: &Value,
) -> Result<(), ApiError> {
    let kind = item["type"].as_str().unwrap_or_default();
    if !matches!(kind, "function_call" | "custom_tool_call") {
        return Ok(());
    }
    let name = item["name"].as_str().unwrap_or_default();
    if !is_worker_tool(name) {
        return Ok(());
    }
    let raw = item[if kind == "function_call" {
        "arguments"
    } else {
        "input"
    }]
    .as_str()
    .unwrap_or_default();
    let Ok((worker, _, _)) = prepare_worker_arguments(name, item["namespace"].as_str(), raw) else {
        return Ok(());
    };
    let existing: Option<String> = c.query_row(
        "SELECT worker_call_id FROM history_records WHERE id=?",
        [record],
        |r| r.get(0),
    )?;
    if existing.is_some() {
        return Ok(());
    }
    let own: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM workers WHERE id=? AND deleted_at IS NULL)",
        [&worker],
        |r| r.get(0),
    )?;
    let shared = {
        let mut q=c.prepare("SELECT owner_user_id,grant_id FROM shared_workers WHERE worker_id=? AND revoked_at IS NULL")?;
        q.query_map([&worker], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let (owner, grant) = if own && shared.is_empty() {
        (None, None)
    } else if !own && shared.len() == 1 {
        (Some(shared[0].0.clone()), Some(shared[0].1.clone()))
    } else {
        (Some(String::new()), None)
    };
    c.execute("UPDATE history_records SET worker_owner_user_id=?,worker_grant_id=?,worker_call_id=?,worker_input_id=? WHERE id=? AND thread_id=?",params![owner,grant,Uuid::new_v4().to_string(),input,record,thread])?;
    Ok(())
}

#[derive(Clone)]
struct Intent {
    id: String,
    owner: Option<String>,
    grant: Option<String>,
    thread: String,
    input: i64,
    payload: Value,
}
fn intent_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Intent> {
    let raw: String = r.get(5)?;
    Ok(Intent {
        id: r.get(0)?,
        owner: r.get(1)?,
        grant: r.get(2)?,
        thread: r.get(3)?,
        input: r.get(4)?,
        payload: serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?,
    })
}
const INTENT_COLUMNS: &str =
    "worker_call_id,worker_owner_user_id,worker_grant_id,thread_id,worker_input_id,payload";

pub(super) async fn enqueue(
    state: &AppState,
    user: &User,
    thread: &str,
    input: i64,
    call: &str,
) -> Result<Option<String>, ApiError> {
    let t = thread.to_owned();
    let call = call.to_owned();
    let intent=user_db(state,user,false,move|c| {
        if !current(c,&t,Some(input))? {return Err(ApiError::cancelled());}
        Ok(c.query_row(&format!("SELECT {INTENT_COLUMNS} FROM history_records WHERE thread_id=? AND worker_input_id=? AND kind='response_output' AND worker_call_id IS NOT NULL AND worker_output_phase IS NULL AND json_extract(payload,'$.call_id')=? ORDER BY id LIMIT 1"),params![t,input,call],intent_row).optional()?)
    }).await?;
    let Some(intent) = intent else {
        return Ok(None);
    };
    let Some(owner) = intent.owner.clone() else {
        return Ok(None);
    };
    if owner.is_empty() {
        return Err(ApiError::not_found(
            "Worker not found or ambiguous at tool creation",
        ));
    }
    let caller = user.id.clone();
    let a = user_from_id(state, owner)?;
    let id = intent.id.clone();
    user_db(state, &a, false, move |c| {
        enqueue_intent(c, &caller, &intent)
    })
    .await?;
    Ok(Some(id))
}
fn enqueue_intent(c: &mut Connection, caller: &str, intent: &Intent) -> Result<(), ApiError> {
    let item = &intent.payload;
    let name = item["name"].as_str().unwrap_or_default();
    let kind = item["type"].as_str().unwrap_or_default();
    let (worker, args, _) = prepare_worker_arguments(
        name,
        item["namespace"].as_str(),
        item[if kind == "function_call" {
            "arguments"
        } else {
            "input"
        }]
        .as_str()
        .unwrap_or_default(),
    )
    .map_err(ApiError::bad_request)?;
    if !matches!(name, "bash" | "browser_control" | "computer_use") {
        return Err(ApiError::bad_request("tool is not shareable"));
    }
    let call = item["call_id"].as_str().unwrap_or_default();
    let output_type = if kind == "function_call" {
        "function_call_output"
    } else {
        "custom_tool_call_output"
    };
    let args = args.to_string();
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing:Option<(String,String,String,String,Option<String>)>=tx.query_row("SELECT id,worker_id,name,arguments_json,grant_id FROM worker_calls WHERE caller_user_id=? AND thread_id=? AND input_record_id=? AND responses_call_id=?",params![caller,intent.thread,intent.input,call],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    if let Some((id, w, n, a, g)) = existing {
        if id != intent.id || w != worker || n != name || a != args || g != intent.grant {
            return Err(ApiError::conflict(
                "repeated tool call ID has different arguments or grant",
            ));
        }
        return Ok(());
    }
    // An existing caller-scoped receipt schedules nothing. Revocation blocks
    // new work, not recovery of an already accepted call and its result.
    authorize(
        &tx,
        &worker,
        caller,
        intent.grant.as_deref().unwrap_or_default(),
    )?;
    let b = read_caller(&tx, caller)?;
    if !current(&b, &intent.thread, Some(intent.input))? {
        return Err(ApiError::cancelled());
    }
    let online: bool = tx.query_row(
        "SELECT status='online' AND COALESCE(last_seen_at>=?,0) FROM workers WHERE id=?",
        params![now() - WORKER_ONLINE_SECONDS, worker],
        |r| r.get(0),
    )?;
    if !online {
        return Err(ApiError::conflict("selected Worker is offline"));
    }
    tx.execute("INSERT INTO worker_calls(id,responses_call_id,responses_output_type,worker_id,thread_id,input_record_id,name,arguments_json,status,created_at,worker_label,worker_hostname,worker_version,worker_resource_json,caller_user_id,grant_id) SELECT ?,?,?,?,?,?,?,?,'queued',?,label,hostname,version,resource_json,?,? FROM workers WHERE id=?",params![intent.id,call,output_type,worker,intent.thread,intent.input,name,args,now(),caller,intent.grant,worker])?;
    tx.commit()?;
    Ok(())
}

fn current(c: &Connection, thread: &str, input: Option<i64>) -> Result<bool, ApiError> {
    let Some(input) = input else {
        return Ok(false);
    };
    let running: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM threads WHERE id=? AND status='running')",
        [thread],
        |r| r.get(0),
    )?;
    Ok(running && latest_request_record_id(c, thread)? == Some(input))
}

// The owner transaction serializes grant revocation with delivery. The caller
// read is a last safe gate, not distributed cancellation of device side effects.
pub(super) fn gate(c: &Connection, id: &str) -> Result<bool, ApiError> {
    let (worker,caller,grant,thread,input):(String,Option<String>,Option<String>,String,Option<i64>)=c.query_row("SELECT worker_id,caller_user_id,grant_id,thread_id,input_record_id FROM worker_calls WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?;
    let active = if let Some(caller) = caller {
        if !grant_active(c, &worker, &caller, grant.as_deref().unwrap_or_default())? {
            false
        } else {
            // Only errors from B are deferrable here. A's grant lookup and
            // retry-marker write must propagate storage errors to the caller.
            match read_caller(c, &caller).and_then(|b| current(&b, &thread, input)) {
                Ok(active) => active,
                Err(error) => {
                    c.execute("UPDATE worker_calls SET dispatch_retry_at=? WHERE id=? AND status IN ('queued','delivered')",params![now()+2,id])?;
                    tracing::warn!(error=%error.message,"Worker dispatch deferred: caller state unavailable");
                    return Ok(false);
                }
            }
        }
    } else {
        let exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM workers WHERE id=? AND deleted_at IS NULL)",
            [worker],
            |r| r.get(0),
        )?;
        exists && current(c, &thread, input)?
    };
    if !active {
        c.execute("UPDATE worker_calls SET status='failed',error='Worker authorization or caller request is no longer active',completed_at=? WHERE id=? AND status IN ('queued','delivered')",params![now(),id])?;
    }
    Ok(active)
}

pub(super) async fn call_owner(state: &AppState, user: &User, id: &str) -> Result<User, ApiError> {
    let id = id.to_owned();
    let owner=user_db(state,user,false,move|c|Ok(c.query_row("SELECT worker_owner_user_id FROM history_records WHERE worker_call_id=? AND worker_output_phase IS NULL",[id],|r|r.get::<_,Option<String>>(0)).optional()?.flatten())).await?;
    match owner {
        Some(owner) => user_from_id(state, owner),
        None => Ok(user.clone()),
    }
}

pub(super) async fn dispatch_committed(
    state: &AppState,
    user: &User,
    ids: Vec<i64>,
) -> Result<(), ApiError> {
    let intents=user_db(state,user,false,move|c| {
        let mut items=Vec::new();for id in ids {
            if let Some(intent)=c.query_row(&format!("SELECT {INTENT_COLUMNS} FROM history_records WHERE id=? AND kind='response_output' AND worker_owner_user_id IS NOT NULL AND worker_owner_user_id<>'' AND worker_call_id IS NOT NULL"),[id],intent_row).optional()? {items.push(intent);}
        }Ok(items)
    }).await?;
    for intent in intents {
        let item = &intent.payload;
        let raw = item[if item["type"] == "function_call" {
            "arguments"
        } else {
            "input"
        }]
        .as_str()
        .unwrap_or_default();
        let Ok((_, _, delay)) = prepare_worker_arguments(
            item["name"].as_str().unwrap_or_default(),
            item["namespace"].as_str(),
            raw,
        ) else {
            continue;
        };
        if delay.is_some() {
            continue;
        }
        let a = user_from_id(state, intent.owner.clone().unwrap_or_default())?;
        let caller = user.id.clone();
        match user_db(state, &a, false, move |c| {
            enqueue_intent(c, &caller, &intent)
        })
        .await
        {
            Ok(()) => {}
            Err(e) if e.status.is_client_error() => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

// Called in A's callback transaction, before acknowledging the Worker. No B I/O.
pub(super) fn save_foreign_result(
    c: &Connection,
    worker: &str,
    id: &str,
    result: &str,
    status: &str,
    error: Option<&str>,
) -> Result<bool, ApiError> {
    type SavedResult = (Option<String>, String, Option<String>, Option<i64>);
    let row:Option<SavedResult>=c.query_row("SELECT caller_user_id,status,result_json,started_at FROM worker_calls WHERE id=? AND worker_id=?",params![id,worker],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((Some(_), previous, saved, started)) = row else {
        return Ok(false);
    };
    if started.is_none() {
        return Err(ApiError::conflict("Worker call has not been delivered"));
    }
    if let Some(saved) = saved {
        if saved != result {
            return Err(ApiError::conflict(
                "conflicting result for completed Worker call",
            ));
        }
        return Ok(true);
    }
    if previous == "delivered" {
        c.execute("UPDATE worker_calls SET status=?,result_json=?,error=?,completed_at=?,received_at=COALESCE(received_at,?) WHERE id=?",params![status,result,error,now(),now(),id])?;
    } else {
        c.execute("UPDATE worker_calls SET result_json=?,late_result=1,received_at=COALESCE(received_at,?) WHERE id=?",params![result,now(),id])?;
    }
    Ok(true)
}

struct Output {
    caller: String,
    thread: String,
    input: Option<i64>,
    call: String,
    output_type: String,
    result: Option<String>,
    error: Option<String>,
    screenshot: bool,
    late: bool,
    primary_done: bool,
    late_done: bool,
    failure_code: Option<String>,
}
fn failure_output(error: Option<&str>, code: Option<&str>) -> Value {
    let mut value = json!({"error":error.unwrap_or("Worker call failed")});
    if code == Some("worker_restarted") {
        value["code"] = "worker_restarted".into();
        value["execution_outcome"] = "unknown".into();
    }
    value
}
fn project_output(c: &Connection, owner: &str, id: &str) -> Result<(), ApiError> {
    let row=c.query_row("SELECT caller_user_id,thread_id,input_record_id,responses_call_id,responses_output_type,result_json,error,name IN ('browser_control','computer_use') AND json_extract(arguments_json,'$.action')='screenshot',late_result,output_record_id IS NOT NULL OR output_discarded=1,late_output_record_id IS NOT NULL OR late_output_discarded=1,failure_code FROM worker_calls WHERE id=? AND caller_user_id IS NOT NULL AND status IN ('completed','failed')",[id],|r|Ok(Output {caller:r.get(0)?,thread:r.get(1)?,input:r.get(2)?,call:r.get(3)?,output_type:r.get(4)?,result:r.get(5)?,error:r.get(6)?,screenshot:r.get::<_,Option<bool>>(7)?.unwrap_or(false),late:r.get(8)?,primary_done:r.get(9)?,late_done:r.get(10)?,failure_code:r.get(11)?})).optional()?;
    let Some(row) = row else {
        return Ok(());
    };
    c.execute(
        "UPDATE worker_calls SET delivery_attempted_at=? WHERE id=?",
        params![now(), id],
    )?;
    let mut b = open_projection(c, &row.caller)?;
    for phase in ["primary", "late"] {
        if (phase == "primary" && row.primary_done)
            || (phase == "late" && (!row.late || row.late_done))
        {
            continue;
        }
        let tx = b.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?)",
            [&row.thread],
            |r| r.get(0),
        )?;
        let output = if !exists {
            None
        } else {
            let existing:Option<i64>=tx.query_row("SELECT id FROM history_records WHERE worker_owner_user_id=? AND worker_call_id=? AND worker_output_phase=?",params![owner,id,phase],|r|r.get(0)).optional()?;
            if let Some(id) = existing {
                Some(id)
            } else {
                let result = if phase == "primary" && row.late || row.result.is_none() {
                    failure_output(row.error.as_deref(), row.failure_code.as_deref()).to_string()
                } else {
                    row.result.clone().unwrap_or_default()
                };
                let kind = if phase == "primary" && current(&tx, &row.thread, row.input)? {
                    "tool_output"
                } else {
                    "activity"
                };
                let payload = json!({"type":row.output_type,"call_id":row.call,"output":result});
                let record = persist_history_record(
                    &tx,
                    HistoryRecordInsert {
                        thread_id: &row.thread,
                        kind,
                        payload: &payload,
                        created_at: now(),
                    },
                )?;
                tx.execute("UPDATE history_records SET worker_owner_user_id=?,worker_call_id=?,worker_output_phase=?,worker_screenshot=? WHERE id=?",params![owner,id,phase,row.screenshot&&(!row.late||phase=="late"),record])?;
                Some(record)
            }
        };
        tx.commit()?;
        // RECOVERY: if A is unavailable after this commit, the history origin
        // index returns the same record on retry, including late-result phase.
        let (column, discard) = if phase == "primary" {
            ("output_record_id", "output_discarded")
        } else {
            ("late_output_record_id", "late_output_discarded")
        };
        c.execute(
            &format!("UPDATE worker_calls SET {column}=?,{discard}=? WHERE id=?"),
            params![output, output.is_none(), id],
        )?;
    }
    Ok(())
}

pub(super) fn recover(c: &Connection, owner: &str) -> Result<(), ApiError> {
    sync_grants(c, owner)?;
    let ids = {
        let mut q=c.prepare("SELECT id FROM worker_calls INDEXED BY worker_calls_pending_output WHERE caller_user_id IS NOT NULL AND status IN ('completed','failed') AND ((output_record_id IS NULL AND output_discarded=0) OR (late_result=1 AND result_json IS NOT NULL AND late_output_record_id IS NULL AND late_output_discarded=0)) ORDER BY delivery_attempted_at,created_at,id LIMIT ?")?;
        q.query_map([BATCH], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for id in ids {
        if let Err(e) = project_output(c, owner, &id) {
            tracing::warn!(error=%e.message,"Worker output delivery deferred");
        }
    }
    Ok(())
}
pub(super) async fn deliver(state: &AppState, owner: &User, id: &str) -> Result<(), ApiError> {
    let id = id.to_owned();
    let uid = owner.id.clone();
    user_db(state, owner, false, move |c| project_output(c, &uid, &id)).await
}

#[cfg(test)]
mod tests;
