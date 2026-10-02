use super::*;

const SYNC_BATCH: i64 = 32;
const MAX_PAGE: usize = 30;

pub(super) fn migrate(c: &Connection) -> Result<(), ApiError> {
    // INVARIANT: grants deliberately have no cascading Thread FK. Deletion must
    // retain tombstones until every recipient projection has observed them.
    c.execute_batch(r#"
CREATE TABLE thread_grants (
 thread_id TEXT NOT NULL, grantee_user_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 permission TEXT NOT NULL DEFAULT 'viewer' CHECK(permission='viewer'),
 revoked_at INTEGER, revision INTEGER NOT NULL, synced_revision INTEGER NOT NULL DEFAULT 0,
 sync_attempted_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(thread_id,grantee_user_id));
CREATE INDEX thread_grants_unsynced ON thread_grants(sync_attempted_at,updated_at,thread_id,grantee_user_id) WHERE revision>synced_revision;
CREATE TABLE shared_threads (
 owner_user_id TEXT NOT NULL, thread_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 permission TEXT NOT NULL CHECK(permission='viewer'), revoked_at INTEGER, revision INTEGER NOT NULL,
 shared_at INTEGER NOT NULL, hidden_at INTEGER,
 PRIMARY KEY(owner_user_id,thread_id));
CREATE INDEX shared_threads_discovery ON shared_threads((hidden_at IS NOT NULL),shared_at DESC,owner_user_id DESC,thread_id DESC) WHERE revoked_at IS NULL;
CREATE TRIGGER threads_revoke_shares BEFORE DELETE ON threads BEGIN
 UPDATE thread_grants SET revoked_at=unixepoch(),updated_at=unixepoch(),revision=revision+1
 WHERE thread_id=OLD.id AND revoked_at IS NULL;
END;
"#)?;
    Ok(())
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/threads/{id}/grants", get(list_grants))
        .route(
            "/api/threads/{id}/grants/{grantee}",
            put(grant).delete(revoke),
        )
        .route("/api/shared-threads", get(list))
        .route("/api/shared-threads/{owner}/{id}", get(read))
        .route(
            "/api/shared-threads/{owner}/{id}/history/window",
            get(history_window),
        )
        .route("/api/shared-threads/{owner}/{id}/history", get(history))
        .route("/api/shared-threads/{owner}/{id}/response", get(response))
        .route(
            "/api/shared-threads/{owner}/{id}/visibility",
            axum::routing::patch(visibility),
        )
        .route_layer(axum::middleware::from_fn(worker_onboarding::no_store))
}

fn exact_user_id(value: &str) -> Result<String, ApiError> {
    let id = user_id(value).map_err(|_| ApiError::bad_request("invalid user ID"))?;
    if id != value {
        return Err(ApiError::bad_request(
            "paste the exact user ID without spaces",
        ));
    }
    Ok(id)
}

fn related_path(c: &Connection, user: &str) -> Result<PathBuf, ApiError> {
    let user = exact_user_id(user)?;
    let parent = c
        .path()
        .filter(|v| !v.is_empty())
        .and_then(|v| Path::new(v).parent())
        .ok_or_else(|| ApiError::internal("user database has no directory"))?;
    Ok(parent.join(format!("{user}.sqlite3")))
}

fn existing_reader(path: &Path) -> Result<Connection, ApiError> {
    let c = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
        |error| {
            tracing::warn!(%error, "shared Thread source unavailable");
            ApiError::unavailable("shared Thread source is temporarily unavailable")
        },
    )?;
    c.busy_timeout(Duration::from_millis(100))?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version != USER_SCHEMA_VERSION {
        return Err(ApiError::unavailable(
            "user database is not ready; retry after signing in",
        ));
    }
    Ok(c)
}

#[derive(Clone, Debug, Serialize)]
struct Grant {
    grantee_user_id: String,
    grant_id: String,
    permission: String,
    revoked_at: Option<i64>,
    revision: i64,
    synced_revision: i64,
    created_at: i64,
    updated_at: i64,
}
const GRANT_COLUMNS: &str = "g.grantee_user_id,g.grant_id,g.permission,g.revoked_at,g.revision,g.synced_revision,g.created_at,g.updated_at";
fn grant_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Grant> {
    Ok(Grant {
        grantee_user_id: r.get(0)?,
        grant_id: r.get(1)?,
        permission: r.get(2)?,
        revoked_at: r.get(3)?,
        revision: r.get(4)?,
        synced_revision: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}
fn get_grant(c: &Connection, thread: &str, grantee: &str) -> Result<Grant, ApiError> {
    Ok(c.query_row(
        &format!(
            "SELECT {GRANT_COLUMNS} FROM thread_grants g WHERE thread_id=? AND grantee_user_id=?"
        ),
        params![thread, grantee],
        grant_row,
    )?)
}

enum GrantAction {
    Grant,
    Revoke,
}
fn change_grant(
    c: &mut Connection,
    owner: &str,
    thread: &str,
    grantee: &str,
    action: GrantAction,
) -> Result<(), ApiError> {
    load_thread(c, thread)?;
    let grantee = exact_user_id(grantee)?;
    if owner == grantee {
        return Err(ApiError::bad_request("cannot share a Thread with yourself"));
    }
    if matches!(action, GrantAction::Grant) {
        let path = related_path(c, &grantee)?;
        if !path.try_exists().map_err(ApiError::internal)? {
            return Err(ApiError::bad_request(
                "recipient must sign in to Cybion first",
            ));
        }
        existing_reader(&path)?;
    }
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
    load_thread(&tx, thread)?;
    let at = now();
    let (changed, verb) = match action {
        GrantAction::Grant => (tx.execute("INSERT INTO thread_grants(thread_id,grantee_user_id,grant_id,revision,created_at,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(thread_id,grantee_user_id) DO UPDATE SET grant_id=excluded.grant_id,revoked_at=NULL,revision=thread_grants.revision+1,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE thread_grants.revoked_at IS NOT NULL", params![thread,grantee,Uuid::new_v4().to_string(),at,at])?, "grant"),
        GrantAction::Revoke => (tx.execute("UPDATE thread_grants SET revoked_at=?,updated_at=?,revision=revision+1 WHERE thread_id=? AND grantee_user_id=? AND revoked_at IS NULL", params![at,at,thread,grantee])?, "revoke"),
    };
    if changed > 0 {
        let grant = get_grant(&tx, thread, &grantee)?;
        persist_history_record(
            &tx,
            HistoryRecordInsert {
                thread_id: thread,
                kind: "activity",
                created_at: at,
                payload: &json!({"type":"thread_share","action":verb,"actor_user_id":owner,"grantee_user_id":grantee,"grant_id":grant.grant_id,"revision":grant.revision,"role":"system","content":format!("Thread sharing: {verb} viewer access for {grantee}")}),
            },
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn sync_grants(c: &Connection, owner: &str) -> Result<(), ApiError> {
    let rows = {
        let mut q = c.prepare(&format!("SELECT g.thread_id,{GRANT_COLUMNS} FROM thread_grants g WHERE revision>synced_revision ORDER BY sync_attempted_at,updated_at,thread_id,grantee_user_id LIMIT ?"))?;
        q.query_map([SYNC_BATCH], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Grant {
                    grantee_user_id: r.get(1)?,
                    grant_id: r.get(2)?,
                    permission: r.get(3)?,
                    revoked_at: r.get(4)?,
                    revision: r.get(5)?,
                    synced_revision: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (thread, g) in rows {
        let attempt = (|| -> Result<(), ApiError> {
            c.execute("UPDATE thread_grants SET sync_attempted_at=? WHERE thread_id=? AND grantee_user_id=?", params![now(),thread,g.grantee_user_id])?;
            let mut b = Connection::open_with_flags(
                related_path(c, &g.grantee_user_id)?,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
            )?;
            b.busy_timeout(Duration::from_millis(100))?;
            ensure_user_schema(&mut b)?;
            b.execute("INSERT INTO shared_threads(owner_user_id,thread_id,grant_id,permission,revoked_at,revision,shared_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,thread_id) DO UPDATE SET hidden_at=CASE WHEN shared_threads.grant_id=excluded.grant_id THEN shared_threads.hidden_at ELSE NULL END,grant_id=excluded.grant_id,permission=excluded.permission,revoked_at=excluded.revoked_at,revision=excluded.revision,shared_at=excluded.shared_at WHERE excluded.revision>shared_threads.revision",params![owner,thread,g.grant_id,g.permission,g.revoked_at,g.revision,g.created_at])?;
            c.execute("UPDATE thread_grants SET synced_revision=? WHERE thread_id=? AND grantee_user_id=? AND revision=?",params![g.revision,thread,g.grantee_user_id,g.revision])?;
            Ok(())
        })();
        // RECOVERY: authoritative changes are committed already. Retry the latest
        // revision through the existing supervisor, never a second authorization.
        if let Err(error) = attempt {
            tracing::warn!(error=%error.message, "Thread share discovery sync deferred");
        }
    }
    Ok(())
}

async fn list_grants(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Vec<Grant>>, ApiError> {
    let id = thread_id(&id)?;
    user_db(&state,&identity.user,false,move |c| {
        load_thread(c,&id)?;
        let mut q = c.prepare(&format!("SELECT {GRANT_COLUMNS} FROM thread_grants g WHERE thread_id=? ORDER BY created_at,grantee_user_id"))?;
        Ok(q.query_map([id],grant_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await.map(Json)
}
async fn grant(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((id, grantee)): AxumPath<(String, String)>,
) -> Result<Json<Grant>, ApiError> {
    let id = thread_id(&id)?;
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        change_grant(c, &owner, &id, &grantee, GrantAction::Grant)?;
        sync_grants(c, &owner)?;
        get_grant(c, &id, &grantee)
    })
    .await
    .map(Json)
}
async fn revoke(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((id, grantee)): AxumPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let id = thread_id(&id)?;
    let owner = identity.user.id.clone();
    user_db(&state, &identity.user, false, move |c| {
        change_grant(c, &owner, &id, &grantee, GrantAction::Revoke)?;
        sync_grants(c, &owner)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

fn unavailable() -> ApiError {
    ApiError::not_found("shared Thread is unavailable")
}

fn read_source<T>(
    path: &Path,
    viewer: &str,
    thread: &str,
    expected_grant: Option<&str>,
    read: impl FnOnce(&Connection, &Grant) -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let mut c = existing_reader(path)?;
    let tx = c.transaction()?;
    let grant = tx.query_row(&format!("SELECT {GRANT_COLUMNS} FROM thread_grants g JOIN threads t ON t.id=g.thread_id WHERE g.thread_id=? AND g.grantee_user_id=? AND g.revoked_at IS NULL AND g.permission='viewer'"), params![thread,viewer], grant_row).optional()?.ok_or_else(unavailable)?;
    if expected_grant.is_some_and(|id| id != grant.grant_id) {
        return Err(unavailable());
    }
    let value = read(&tx, &grant)?;
    tx.commit()?;
    Ok(value)
}

async fn shared_db<T, F>(
    state: &AppState,
    viewer: &User,
    owner: String,
    thread: String,
    read: F,
) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&Connection, &Grant) -> Result<T, ApiError> + Send + 'static,
{
    let owner = exact_user_id(&owner).map_err(|_| unavailable())?;
    let path = user_from_id(state, owner)?.path;
    let viewer = viewer.id.clone();
    tokio::task::spawn_blocking(move || read_source(&path, &viewer, &thread, None, read))
        .await
        .map_err(ApiError::internal)?
}

#[derive(Debug, Serialize)]
struct SharedThread {
    id: String,
    owner_user_id: String,
    grant_id: String,
    access: &'static str,
    title: String,
    status: String,
    display_status: String,
    usage: ThreadUsage,
    created_at: i64,
    updated_at: i64,
    shared_at: i64,
}
fn shared_view(
    c: &Connection,
    owner: &str,
    id: &str,
    grant: &Grant,
) -> Result<SharedThread, ApiError> {
    let thread = load_thread(c, id)?;
    Ok(SharedThread {
        id: thread.id,
        owner_user_id: owner.to_owned(),
        grant_id: grant.grant_id.clone(),
        access: "viewer",
        title: thread.title,
        status: thread.status,
        display_status: thread.display_status,
        usage: thread.usage,
        created_at: thread.created_at,
        updated_at: thread.updated_at,
        shared_at: grant.created_at,
    })
}
async fn read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((owner, id)): AxumPath<(String, String)>,
) -> Result<Json<SharedThread>, ApiError> {
    let id = thread_id(&id)?;
    let source = owner.clone();
    shared_db(&state, &identity.user, owner, id.clone(), move |c, g| {
        shared_view(c, &source, &id, g)
    })
    .await
    .map(Json)
}

#[derive(Default, Deserialize)]
struct ListQuery {
    limit: Option<usize>,
    cursor: Option<String>,
    hidden: Option<bool>,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    shared_at: i64,
    owner: String,
    thread: String,
}
#[derive(Serialize)]
struct SharedPage {
    items: Vec<SharedThread>,
    next_cursor: Option<String>,
}
struct Discovery {
    cursor: Cursor,
    grant: String,
}
fn discovery(
    c: &Connection,
    query: ListQuery,
) -> Result<(Vec<Discovery>, Option<String>), ApiError> {
    let limit = query.limit.unwrap_or(MAX_PAGE);
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(ApiError::bad_request("limit must be between 1 and 30"));
    }
    let cursor = query
        .cursor
        .map(|value| {
            if value.len() > 1024 {
                return Err(ApiError::bad_request("invalid cursor"));
            }
            let bytes = hex::decode(value).map_err(|_| ApiError::bad_request("invalid cursor"))?;
            serde_json::from_slice::<Cursor>(&bytes)
                .map_err(|_| ApiError::bad_request("invalid cursor"))
        })
        .transpose()?;
    let mut q=c.prepare("SELECT owner_user_id,thread_id,grant_id,shared_at FROM shared_threads WHERE revoked_at IS NULL AND (hidden_at IS NOT NULL)=?1 AND (?2 IS NULL OR (shared_at,owner_user_id,thread_id)<(?2,?3,?4)) ORDER BY shared_at DESC,owner_user_id DESC,thread_id DESC LIMIT ?5")?;
    let mut rows = q
        .query_map(
            params![
                query.hidden.unwrap_or(false),
                cursor.as_ref().map(|c| c.shared_at),
                cursor.as_ref().map(|c| &c.owner),
                cursor.as_ref().map(|c| &c.thread),
                limit + 1
            ],
            |r| {
                Ok(Discovery {
                    cursor: Cursor {
                        owner: r.get(0)?,
                        thread: r.get(1)?,
                        shared_at: r.get(3)?,
                    },
                    grant: r.get(2)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        Some(hex::encode(
            serde_json::to_vec(&rows.last().unwrap().cursor).map_err(ApiError::internal)?,
        ))
    } else {
        None
    };
    Ok((rows, next))
}
async fn list(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    Query(query): Query<ListQuery>,
) -> Result<Json<SharedPage>, ApiError> {
    let (rows, next_cursor) =
        user_db(&state, &identity.user, false, move |c| discovery(c, query)).await?;
    let viewer = identity.user.id;
    tokio::task::spawn_blocking(move || {
        let mut items = Vec::new();
        for row in rows {
            let path = user_from_id(&state, exact_user_id(&row.cursor.owner)?)?.path;
            match read_source(
                &path,
                &viewer,
                &row.cursor.thread,
                Some(&row.grant),
                |c, g| shared_view(c, &row.cursor.owner, &row.cursor.thread, g),
            ) {
                Ok(item) => items.push(item),
                Err(e) if e.status == StatusCode::NOT_FOUND => {}
                Err(e) => return Err(e),
            }
        }
        Ok(Json(SharedPage { items, next_cursor }))
    })
    .await
    .map_err(ApiError::internal)?
}

#[derive(Deserialize)]
struct Visibility {
    hidden: bool,
}
async fn visibility(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((owner, id)): AxumPath<(String, String)>,
    Json(input): Json<Visibility>,
) -> Result<StatusCode, ApiError> {
    let owner = exact_user_id(&owner)?;
    let id = thread_id(&id)?;
    user_db(&state,&identity.user,false,move |c| {
        let changed=c.execute("UPDATE shared_threads SET hidden_at=? WHERE owner_user_id=? AND thread_id=? AND revoked_at IS NULL",params![input.hidden.then(now),owner,id])?;
        if changed==0 {return Err(unavailable());}
        Ok(())
    }).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn select_fields(value: &Value, names: &[&str]) -> Value {
    let mut result = serde_json::Map::new();
    for name in names {
        if let Some(v) = value.get(name) {
            result.insert((*name).to_owned(), v.clone());
        }
    }
    Value::Object(result)
}

// Only conversation content crosses this boundary. Extra protocol fields,
// encrypted replay state and provider metadata do not become public by default.
fn shared_payload(value: &Value) -> Value {
    if value.is_string() {
        return value.clone();
    }
    let names: &[&str] = match value.get("type").and_then(Value::as_str) {
        Some("reasoning") => &["type", "id", "summary"],
        Some("function_call") => &["type", "id", "call_id", "name", "namespace", "arguments"],
        Some("custom_tool_call") => &[
            "type",
            "id",
            "call_id",
            "name",
            "namespace",
            "input",
            "status",
        ],
        Some("function_call_output" | "custom_tool_call_output") => {
            &["type", "id", "call_id", "output", "name"]
        }
        Some("web_search_call") => &["type", "id", "status", "action"],
        Some("image_generation_call") => &[
            "type",
            "id",
            "status",
            "revised_prompt",
            "result",
            "output_format",
        ],
        _ => &["type", "id", "role", "content", "phase", "action", "status"],
    };
    let mut result = select_fields(value, names);
    for key in ["content", "summary"] {
        if let Some(parts) = result.get_mut(key).and_then(Value::as_array_mut) {
            for part in parts {
                *part = select_fields(part, &["type", "text", "image_url", "detail", "refusal"]);
            }
        }
    }
    result
}
fn shared_records(records: Vec<HistoryRecord>) -> Vec<HistoryRecord> {
    records
        .into_iter()
        .filter(|r| !(r.kind == "activity" && r.payload["type"] == "thread_share"))
        .map(|mut r| {
            r.payload = shared_payload(&r.payload);
            r
        })
        .collect()
}

async fn history_window(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((owner, id)): AxumPath<(String, String)>,
    Query(query): Query<ThreadHistoryWindowQuery>,
) -> Result<Json<ThreadHistoryWindow>, ApiError> {
    let id = thread_id(&id)?;
    shared_db(&state, &identity.user, owner, id.clone(), move |c, _| {
        let window = match query.before {
            None => thread_history_tail(c, &id)?,
            Some(before) => thread_history_older_page(c, &id, before)?,
        };
        Ok(ThreadHistoryWindow {
            records: shared_records(window.records),
            has_older: window.has_older,
        })
    })
    .await
    .map(Json)
}
async fn history(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((owner, id)): AxumPath<(String, String)>,
    Query(query): Query<ThreadHistoryQuery>,
) -> Result<Json<Vec<HistoryRecord>>, ApiError> {
    let id = thread_id(&id)?;
    let after = query.after.unwrap_or(0);
    if after < 0 {
        return Err(ApiError::bad_request("after must not be negative"));
    }
    shared_db(&state, &identity.user, owner, id.clone(), move |c, _| {
        Ok(shared_records(load_history(c, &id, after)?))
    })
    .await
    .map(Json)
}
#[derive(Serialize)]
struct SharedResponse {
    started_at: i64,
    status: String,
    response: Value,
}
async fn response(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath((owner, id)): AxumPath<(String, String)>,
) -> Result<Json<Option<SharedResponse>>, ApiError> {
    let id = thread_id(&id)?;
    shared_db(&state,&identity.user,owner,id.clone(),move |c,_| {
        Ok(load_thread_response(c,&id)?.map(|v|SharedResponse {
            started_at:v.started_at,status:v.status,response:json!({"completed":v.response.completed,"output":v.response.output.into_iter().map(|o|json!({"item":shared_payload(&o.item.value()),"done":o.done,"record_id":o.record_id})).collect::<Vec<_>>()})
        }))
    }).await.map(Json)
}

#[cfg(test)]
mod tests;
