use super::*;

const MAX_FAILURES: i64 = 5;

pub(super) async fn supervise(state: AppState) {
    loop {
        if let Err(error) = resume_running(&state).await {
            tracing::error!(error=%error.message,"could not recover running Threads");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

pub(super) async fn resume_running(state: &AppState) -> Result<(), ApiError> {
    for entry in fs::read_dir(state.data_dir.join("users")).map_err(ApiError::internal)? {
        let path = entry.map_err(ApiError::internal)?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let user = user_from_id(state, id.to_owned())?;
        let ids = user_db(state, &user, false, |c| {
            let mut q =
                c.prepare("SELECT id FROM threads WHERE status='running' ORDER BY updated_at,id")?;
            Ok(q.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await?;
        for id in ids {
            ensure_thread_loop(state, &user, id).await?;
        }
    }
    Ok(())
}

pub(super) async fn ensure_thread_loop(
    state: &AppState,
    user: &User,
    thread_id: String,
) -> Result<(), ApiError> {
    let key = request_key(user, &thread_id);
    let mut active = state.active_requests.lock().await;
    if active
        .get(&key)
        .is_some_and(|entry| entry.cancellation.receiver_count() > 0)
    {
        return Ok(());
    }
    let request=user_db(state,user,false,{
        let id=thread_id.clone();
        move |c| {
            if load_thread(c,&id)?.status!="running" {return Ok(None);}
            let idx=latest_request_record_id(c,&id)?.ok_or_else(||ApiError::internal("running Thread has no input"))?;
            let compact:bool=c.query_row("SELECT kind='activity' AND json_extract(payload,'$.action')='compact' FROM history_records WHERE id=?",[idx],|r|r.get::<_,Option<bool>>(0))?.unwrap_or(false);
            Ok(Some((idx,if compact {RequestOperation::Compact}else{RequestOperation::Inference})))
        }
    }).await?;
    let Some((idx, operation)) = request else {
        return Ok(());
    };
    let (cancellation, receiver) = watch::channel(false);
    active.insert(
        key,
        ActiveRequest {
            record_idx: idx,
            cancellation,
        },
    );
    drop(active);
    tokio::spawn(process_request(
        state.clone(),
        user.clone(),
        thread_id,
        idx,
        operation,
        receiver,
    ));
    Ok(())
}

pub(super) fn current_context(
    c: &mut Connection,
    thread: &str,
    input: i64,
) -> Result<CompiledThreadContext, ApiError> {
    let tx = c.transaction()?;
    if latest_request_record_id(&tx, thread)? != Some(input)
        || load_thread(&tx, thread)?.status != "running"
    {
        return Err(ApiError::cancelled());
    }
    let tail = latest_protocol_record_id(&tx, thread)?;
    let context = compile_thread_context(&tx, thread, tail)?;
    tx.commit()?;
    Ok(context)
}

pub(super) async fn wait_retry(
    state: &AppState,
    user: &User,
    thread: &str,
    input: i64,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    let id = thread.to_owned();
    let at: Option<i64> = user_db(state, user, false, move |c| {
        if request_superseded(c, &id, input)? {
            return Err(ApiError::cancelled());
        }
        Ok(
            c.query_row("SELECT next_retry_at FROM threads WHERE id=?", [id], |r| {
                r.get(0)
            })?,
        )
    })
    .await?;
    if let Some(at) = at
        && at > now()
    {
        tokio::select! {
            _=tokio::time::sleep(Duration::from_secs((at-now()).max(0) as u64))=>{},
            _=cancellation.changed()=>return Err(ApiError::cancelled()),
        }
    }
    if *cancellation.borrow() {
        return Err(ApiError::cancelled());
    }
    Ok(())
}

pub(super) async fn retry(
    state: &AppState,
    user: &User,
    thread: &str,
    input: i64,
    error: &ApiError,
) -> Result<bool, ApiError> {
    let ApiErrorKind::Transient { retry_after_ms } = error.kind else {
        return Ok(false);
    };
    let id = thread.to_owned();
    let message = error.message.clone();
    user_db(state,user,false,move |c|{
        let tx=c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if request_superseded(&tx,&id,input)? || load_thread(&tx,&id)?.status!="running" {return Err(ApiError::cancelled());}
        let failures:i64=tx.query_row("SELECT retry_count FROM threads WHERE id=?",[&id],|r|r.get(0))?;
        let failures=failures+1;
        let base=(1_u64<<((failures-1).min(5) as u32)).min(30);
        let seconds=retry_after_ms.map(|ms|ms.saturating_add(999)/1000).unwrap_or(base + u64::from(Uuid::new_v4().as_bytes()[0])%2);
        let at=now().saturating_add(seconds.min(i64::MAX as u64) as i64);
        tx.execute("UPDATE threads SET retry_count=?,next_retry_at=?,status=CASE WHEN ?>=5 THEN 'failed' ELSE status END WHERE id=?",params![failures,at,failures,id])?;
        if failures<MAX_FAILURES {
            persist_history_record(&tx,HistoryRecordInsert{thread_id:&id,kind:"activity",payload:&json!({"role":"system","content":format!("Transient model error; retry {failures}/{} scheduled: {message}",MAX_FAILURES-1),"next_retry_at":at}),created_at:now()})?;
        }
        tx.commit()?;Ok(failures<MAX_FAILURES)
    }).await
}

pub(super) async fn settle_tools(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    input: i64,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    let id = thread.id.clone();
    let pending=user_db(state,user,false,move |c| {
        if request_superseded(c,&id,input)? {return Err(ApiError::cancelled());}
        let mut q=c.prepare("SELECT h.payload FROM history_records h WHERE h.thread_id=? AND h.id>? AND h.kind='response_output' AND json_extract(h.payload,'$.type') IN ('function_call','custom_tool_call','tool_search_call') AND NOT EXISTS(SELECT 1 FROM history_records o WHERE o.thread_id=h.thread_id AND o.id>h.id AND o.kind='tool_output' AND json_extract(o.payload,'$.call_id')=json_extract(h.payload,'$.call_id')) ORDER BY h.id")?;
        Ok(q.query_map(params![id,input],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }).await?;
    for item in pending {
        if *cancellation.borrow() {
            return Err(ApiError::cancelled());
        }
        let item =
            ResponseItem::from_value(serde_json::from_str(&item).map_err(ApiError::internal)?)
                .map_err(ApiError::internal)?;
        if let Some(PendingToolCall::Worker {
            id,
            call_id,
            output_type,
        }) = start_response_tool(state, user, thread, input, &item).await?
        {
            let (result, output_id) = wait_worker_result(state, user, &id, cancellation).await?;
            if output_id.is_none() {
                append_tool_output_item(
                    state,
                    user,
                    thread,
                    input,
                    &json!({"type":output_type,"call_id":call_id,"output":result.to_string()}),
                )
                .await?;
            }
        }
    }
    Ok(())
}

pub(super) fn retry_after(headers: &HeaderMap) -> Option<u64> {
    let raw = headers.get("retry-after")?.to_str().ok()?;
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(seconds.saturating_mul(1000));
    }
    let date = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some((date.timestamp() - now()).max(0) as u64 * 1000)
}

#[cfg(test)]
mod tests;
