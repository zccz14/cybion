use super::*;

#[derive(Deserialize)]
struct ConsumerVerification {
    id: String,
    credential_matches: bool,
    is_disabled: bool,
    request_archive: bool,
}

fn request(
    state: &AppState,
    bearer: &str,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    state
        .client
        .request(method, url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(15))
}

async fn verify(
    state: &AppState,
    bearer: &str,
    settings: &IntegrationSettings,
) -> Result<Option<ConsumerVerification>, ApiError> {
    if settings.openai_consumer_id.is_empty() {
        return Ok(None);
    }
    let response = request(
        state,
        bearer,
        reqwest::Method::POST,
        &format!(
            "{}/{}/verify",
            state.openai_consumers_url, settings.openai_consumer_id
        ),
    )
    .json(&json!({"secret":settings.openai_consumer_secret}))
    .send()
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let verification = response
        .error_for_status()?
        .json::<ConsumerVerification>()
        .await?;
    if verification.id != settings.openai_consumer_id {
        return Err(ApiError::unavailable(
            "OpenAI-LB returned a different Consumer during credential verification",
        ));
    }
    Ok(Some(verification))
}

async fn save_grant(
    state: &AppState,
    user: &User,
    settings: &mut IntegrationSettings,
    grant: OpenAiConsumerGrant,
) -> Result<(), ApiError> {
    if grant.id.is_empty() || !grant.secret.starts_with("sk-") {
        return Err(ApiError::unavailable(
            "OpenAI-LB returned an invalid Consumer credential",
        ));
    }
    settings.openai_consumer_id = grant.id;
    settings.openai_consumer_secret = grant.secret;
    settings.openai_base_url = OPENAI_BASE_URL.to_owned();
    // RECOVERY: LB shows a new secret only once. Persist it before another
    // network call (including Linkit) can fail; a later refresh can verify it.
    save_integration_settings(state, user, settings).await
}

async fn repair_existing(
    state: &AppState,
    user: &User,
    bearer: &str,
    settings: &mut IntegrationSettings,
    verification: ConsumerVerification,
) -> Result<(), ApiError> {
    let url = format!(
        "{}/{}",
        state.openai_consumers_url, settings.openai_consumer_id
    );
    if verification.is_disabled || !verification.request_archive {
        request(state, bearer, reqwest::Method::PATCH, &url)
            .json(&json!({"is_disabled":false,"request_archive":true}))
            .send()
            .await?
            .error_for_status()?;
    }
    if !verification.credential_matches {
        let grant = request(
            state,
            bearer,
            reqwest::Method::POST,
            &format!("{url}/rotate"),
        )
        .send()
        .await?
        .error_for_status()?
        .json::<OpenAiConsumerGrant>()
        .await?;
        if grant.id != settings.openai_consumer_id {
            return Err(ApiError::unavailable(
                "OpenAI-LB returned a different Consumer during credential rotation",
            ));
        }
        save_grant(state, user, settings, grant).await?;
    }
    Ok(())
}

pub(super) async fn reconcile(
    state: &AppState,
    user: &User,
    bearer: &str,
    settings: &mut IntegrationSettings,
) -> Result<(), ApiError> {
    // INVARIANT: Both provisioning and explicit refresh hold the same per-user
    // lock through remote changes and local persistence.
    match verify(state, bearer, settings).await? {
        Some(verification) => repair_existing(state, user, bearer, settings, verification).await?,
        None => {
            let grant = request(
                state,
                bearer,
                reqwest::Method::POST,
                &state.openai_consumers_url,
            )
            .json(&json!({"name":INTEGRATION_NAME,"request_archive":true}))
            .send()
            .await?
            .error_for_status()?
            .json::<OpenAiConsumerGrant>()
            .await?;
            save_grant(state, user, settings, grant).await?;
        }
    }
    settings.openai_base_url = OPENAI_BASE_URL.to_owned();
    save_integration_settings(state, user, settings).await
}

pub(super) async fn verify_ready(
    state: &AppState,
    bearer: &str,
    settings: &IntegrationSettings,
) -> Result<(), ApiError> {
    let verification = verify(state, bearer, settings).await?;
    if !verification.is_some_and(|consumer| {
        consumer.credential_matches && !consumer.is_disabled && consumer.request_archive
    }) {
        return Err(ApiError::unavailable(
            "OpenAI-LB Consumer changed during refresh; refresh integrations again before retrying the Thread",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
