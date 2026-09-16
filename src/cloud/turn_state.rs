use super::{ApiError, AppState, AuditSpec, IntegrationSettings, hash_secret, user_db};
use axum::http::HeaderValue;
use rusqlite::{OptionalExtension, params};

pub(super) fn upstream_key(integrations: &IntegrationSettings) -> String {
    hash_secret(&format!(
        "{}\n{}",
        integrations.openai_base_url.trim_end_matches('/'),
        integrations.openai_consumer_secret
    ))
}

pub(super) async fn load(
    state: &AppState,
    spec: &AuditSpec,
    key: &str,
) -> Result<Option<HeaderValue>, ApiError> {
    let thread_id = spec.thread_id.clone();
    let key = key.to_owned();
    user_db(state, &spec.user, false, move |connection| {
        let value: Option<Vec<u8>> = connection
            .query_row(
                "SELECT value FROM thread_turn_states WHERE thread_id=? AND upstream_key=?",
                params![thread_id, key],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|value| HeaderValue::from_bytes(&value).map_err(ApiError::internal))
            .transpose()
    })
    .await
}

pub(super) async fn save(
    state: &AppState,
    spec: &AuditSpec,
    key: &str,
    value: &HeaderValue,
) -> Result<(), ApiError> {
    let thread_id = spec.thread_id.clone();
    let key = key.to_owned();
    let value = value.as_bytes().to_vec();
    user_db(state, &spec.user, false, move |connection| {
        connection.execute(
            "INSERT INTO thread_turn_states(thread_id,upstream_key,value) VALUES(?,?,?)
             ON CONFLICT(thread_id) DO UPDATE SET upstream_key=excluded.upstream_key,value=excluded.value",
            params![thread_id, key, value],
        )?;
        Ok(())
    })
    .await
}
