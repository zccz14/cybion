use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RequestOperation {
    Inference,
    Compact,
}

pub(super) enum RequestInput {
    Prompt(String),
    Continue,
    Compact,
}

pub(super) fn latest_request_record_id(
    connection: &Connection,
    thread_id: &str,
) -> Result<Option<i64>, ApiError> {
    connection
        .query_row(
            "SELECT MAX(id) FROM history_records WHERE thread_id=?
             AND (kind='input' OR (kind='activity' AND json_extract(payload,'$.type')='thread_control'))",
            [thread_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub(super) fn request_superseded(
    connection: &Connection,
    thread_id: &str,
    record_idx: i64,
) -> Result<bool, ApiError> {
    Ok(latest_request_record_id(connection, thread_id)?.is_some_and(|id| id > record_idx))
}

pub(super) fn request_context_tail(
    connection: &Connection,
    thread_id: &str,
    record_idx: i64,
) -> Result<i64, ApiError> {
    connection
        .query_row(
            "SELECT MAX(id) FROM history_records WHERE thread_id=? AND id<=?
             AND kind IN ('input','response_output','tool_output','checkpoint')",
            params![thread_id, record_idx],
            |row| row.get::<_, Option<i64>>(0),
        )?
        .ok_or_else(|| ApiError::conflict("thread has no protocol history"))
}

fn control_record(connection: &Connection, thread_id: &str, action: &str) -> Result<i64, ApiError> {
    persist_history_record(
        connection,
        HistoryRecordInsert {
            thread_id,
            kind: "activity",
            payload: &json!({"type":"thread_control","action":action}),
            created_at: now(),
        },
    )
}

fn record_request(
    connection: &mut Connection,
    thread_id: &str,
    input: RequestInput,
) -> Result<(i64, RequestOperation), ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let thread = load_thread(&transaction, thread_id)?;
    let (record_idx, operation) = match input {
        RequestInput::Prompt(input) => (
            persist_history_record(
                &transaction,
                HistoryRecordInsert {
                    thread_id,
                    kind: "input",
                    payload: &json!({"role":"user","content":input}),
                    created_at: now(),
                },
            )?,
            RequestOperation::Inference,
        ),
        control @ (RequestInput::Continue | RequestInput::Compact) => {
            if thread.status == "running" {
                return Err(ApiError::conflict("stop the current request first"));
            }
            latest_protocol_record_id(&transaction, thread_id)?;
            let (action, operation) = if matches!(control, RequestInput::Compact) {
                ("compact", RequestOperation::Compact)
            } else {
                ("continue", RequestOperation::Inference)
            };
            (control_record(&transaction, thread_id, action)?, operation)
        }
    };
    transaction.execute(
        "UPDATE threads SET status='running',retry_count=0,next_retry_at=NULL,updated_at=? WHERE id=?",
        params![now(), thread_id],
    )?;
    transaction.commit()?;
    Ok((record_idx, operation))
}

pub(super) async fn enqueue(
    state: AppState,
    user: User,
    thread_id: String,
    input: RequestInput,
) -> Result<RequestView, ApiError> {
    // INVARIANT: registration and cancellation share this lock so the durable
    // request boundary and its cancellation sender become visible together.
    let mut active = state.active_requests.lock().await;
    let queued_thread_id = thread_id.clone();
    let (record_idx, operation) = user_db(&state, &user, true, move |connection| {
        record_request(connection, &queued_thread_id, input)
    })
    .await?;
    let (cancellation, receiver) = watch::channel(false);
    if let Some(previous) = active.insert(
        request_key(&user, &thread_id),
        ActiveRequest {
            record_idx,
            cancellation,
        },
    ) {
        let _ = previous.cancellation.send(true);
    }
    drop(active);
    tokio::spawn(process_request(
        state,
        user,
        thread_id.clone(),
        record_idx,
        operation,
        receiver,
    ));
    Ok(RequestView {
        thread_id,
        record_idx,
        status: "accepted".to_owned(),
    })
}

pub(super) async fn cancel_for(
    state: &AppState,
    user: &User,
    thread_id: String,
) -> Result<ThreadView, ApiError> {
    let mut active = state.active_requests.lock().await;
    let cancelled_thread_id = thread_id.clone();
    let thread = user_db(state, user, true, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let thread = load_thread(&transaction, &cancelled_thread_id)?;
        if thread.status != "running" {
            return Ok(thread);
        }
        control_record(&transaction, &cancelled_thread_id, "cancel")?;
        transaction.execute(
            "UPDATE threads SET status='idle',updated_at=? WHERE id=?",
            params![now(), &cancelled_thread_id],
        )?;
        transaction.execute(
            "UPDATE reasoning_audits SET status='cancelled',finished_at=?,error='Cancelled by user'
             WHERE thread_id=? AND status='in_flight'",
            params![now(), &cancelled_thread_id],
        )?;
        transaction.execute(
            "UPDATE worker_calls SET status='failed',completed_at=?,error='Cancelled by user'
             WHERE thread_id=? AND status IN ('queued','delivered')",
            params![now(), &cancelled_thread_id],
        )?;
        let thread = load_thread(&transaction, &cancelled_thread_id)?;
        transaction.commit()?;
        Ok(thread)
    })
    .await?;
    if let Some(request) = active.remove(&request_key(user, &thread_id)) {
        let _ = request.cancellation.send(true);
    }
    Ok(thread)
}

pub(super) async fn cancel(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ThreadView>, ApiError> {
    Ok(Json(
        cancel_for(&state, &identity.user, thread_id(&id)?).await?,
    ))
}

pub(super) async fn continue_thread(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<RequestView>, ApiError> {
    let id = thread_id(&id)?;
    read_thread_for(&state, &identity.user, id.clone()).await?;
    ensure_openai_integration(&state, &identity.user, &identity.bearer).await?;
    Ok(Json(
        enqueue(state, identity.user, id, RequestInput::Continue).await?,
    ))
}

pub(super) async fn compact(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<RequestView>, ApiError> {
    let id = thread_id(&id)?;
    read_thread_for(&state, &identity.user, id.clone()).await?;
    ensure_openai_integration(&state, &identity.user, &identity.bearer).await?;
    Ok(Json(
        enqueue(state, identity.user, id, RequestInput::Compact).await?,
    ))
}

pub(super) async fn compact_request(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    integrations: &IntegrationSettings,
    record_idx: i64,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    loop {
        recovery::wait_retry(state, user, &thread.id, record_idx, cancellation).await?;
        let result = async {
            let context = user_db(state, user, false, {
                let thread_id = thread.id.clone();
                move |connection| {
                    let tail = request_context_tail(connection, &thread_id, record_idx)?;
                    compile_thread_context(connection, &thread_id, tail)
                }
            })
            .await?;
            compact_thread_context(
                state,
                user,
                thread,
                &context,
                integrations,
                record_idx,
                cancellation,
            )
            .await?;
            Ok(())
        }
        .await;
        if let Err(error) = &result
            && recovery::retry(state, user, &thread.id, record_idx, error).await?
        {
            continue;
        }
        return result;
    }
}

#[cfg(test)]
#[path = "thread_controls_tests.rs"]
mod tests;
