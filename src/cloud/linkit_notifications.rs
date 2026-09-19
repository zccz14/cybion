use super::*;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  conversation_id TEXT,
  message_id TEXT
);";

#[derive(Debug, Serialize)]
pub(super) struct NotificationStatus {
    enabled: bool,
    configured: bool,
    bot_id: Option<String>,
    recipient_username: Option<String>,
    last_attempt_at: Option<i64>,
    last_success_at: Option<i64>,
    last_error: Option<String>,
    conversation_id: Option<String>,
    message_id: Option<String>,
}

#[derive(Deserialize)]
struct Identity {
    id: String,
    profile: Option<Profile>,
}

#[derive(Deserialize)]
struct Profile {
    username: String,
}

#[derive(Deserialize)]
struct OwnedBot {
    id: String,
    owner_user_id: String,
}

#[derive(Deserialize)]
struct BotGrant {
    id: String,
    token: String,
}

#[derive(Deserialize)]
struct DirectConversation {
    id: String,
    kind: String,
    counterpart_user_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DeliveryReceipt {
    id: String,
    conversation_id: String,
    sender_id: String,
    sender_kind: String,
}

fn configured(settings: &IntegrationSettings) -> bool {
    !settings.linkit_bot_id.is_empty()
        && !settings.linkit_bot_token.is_empty()
        && !settings.linkit_username.is_empty()
}

fn request(
    state: &AppState,
    bearer: &str,
    method: reqwest::Method,
    segments: &[&str],
) -> Result<reqwest::RequestBuilder, ApiError> {
    let mut url = url::Url::parse(&state.linkit_api_url).map_err(ApiError::internal)?;
    url.path_segments_mut()
        .map_err(|_| ApiError::internal("Linkit URL must support path segments"))?
        .pop_if_empty()
        .extend(segments);
    Ok(state
        .client
        .request(method, url)
        .bearer_auth(bearer)
        .timeout(Duration::from_secs(15)))
}

fn checked(response: reqwest::Response, operation: &str) -> Result<reqwest::Response, ApiError> {
    if !response.status().is_success() {
        return Err(ApiError::unavailable(format!(
            "Linkit {operation} failed (HTTP {}). Configure or repair notifications and send a test message.",
            response.status().as_u16(),
        )));
    }
    Ok(response)
}

fn status(connection: &Connection) -> Result<NotificationStatus, ApiError> {
    let settings = integration_settings(connection)?;
    connection.query_row(
        "SELECT enabled,last_attempt_at,last_success_at,last_error,conversation_id,message_id FROM notification_settings WHERE id=1",
        [],
        |row| Ok(NotificationStatus {
            enabled: row.get(0)?,
            configured: configured(&settings),
            bot_id: (!settings.linkit_bot_id.is_empty()).then_some(settings.linkit_bot_id),
            recipient_username: (!settings.linkit_username.is_empty()).then_some(settings.linkit_username),
            last_attempt_at: row.get(1)?, last_success_at: row.get(2)?, last_error: row.get(3)?,
            conversation_id: row.get(4)?, message_id: row.get(5)?,
        }),
    ).map_err(Into::into)
}

pub(super) async fn read(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<NotificationStatus>, ApiError> {
    user_db(&state, &identity.user, true, |connection| {
        status(connection)
    })
    .await
    .map(Json)
}

async fn set_enabled(state: &AppState, user: &User, enabled: bool) -> Result<(), ApiError> {
    user_db(state, user, true, move |connection| {
        connection.execute(
            "UPDATE notification_settings SET enabled=? WHERE id=1",
            [enabled],
        )?;
        Ok(())
    })
    .await
}

pub(super) async fn disable(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<NotificationStatus>, ApiError> {
    let _guard = lock_integrations(&state, format!("linkit:{}", identity.user.id)).await;
    set_enabled(&state, &identity.user, false).await?;
    read(State(state), axum::Extension(identity)).await
}

async fn token_matches(state: &AppState, settings: &IntegrationSettings) -> Result<bool, ApiError> {
    if settings.linkit_bot_token.is_empty() {
        return Ok(false);
    }
    let response = request(
        state,
        &settings.linkit_bot_token,
        reqwest::Method::GET,
        &["api", "me"],
    )?
    .send()
    .await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Ok(false);
    }
    let identity = checked(response, "Bot authentication")?
        .json::<Identity>()
        .await?;
    Ok(identity.id == settings.linkit_bot_id)
}

async fn save_settings(
    state: &AppState,
    user: &User,
    settings: &IntegrationSettings,
) -> Result<(), ApiError> {
    let saved = settings.clone();
    user_db(state, user, true, move |connection| {
        connection.execute(
            "INSERT INTO integration_settings(id,linkit_bot_id,linkit_bot_token,linkit_username,updated_at)
             VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET linkit_bot_id=excluded.linkit_bot_id,
             linkit_bot_token=excluded.linkit_bot_token,linkit_username=excluded.linkit_username,updated_at=excluded.updated_at",
            params![saved.linkit_bot_id,saved.linkit_bot_token,saved.linkit_username,now()],
        )?;
        Ok(())
    }).await
}

async fn save_grant(
    state: &AppState,
    user: &User,
    settings: &mut IntegrationSettings,
    grant: BotGrant,
) -> Result<(), ApiError> {
    if grant.id.is_empty() || !grant.token.starts_with("sk-") {
        return Err(ApiError::unavailable(
            "Linkit returned an invalid Bot credential",
        ));
    }
    settings.linkit_bot_id = grant.id;
    settings.linkit_bot_token = grant.token;
    // RECOVERY: A newly issued Bot token is only returned once. Save it before
    // a subsequent remote validation can fail; repair can reuse it next time.
    save_settings(state, user, settings).await
}

async fn repair_bot(
    state: &AppState,
    user: &User,
    bearer: &str,
    settings: &mut IntegrationSettings,
) -> Result<(), ApiError> {
    let bots = checked(
        request(state, bearer, reqwest::Method::GET, &["api", "bots"])?
            .send()
            .await?,
        "list owned Bots",
    )?
    .json::<Vec<OwnedBot>>()
    .await?;
    let owned = bots
        .iter()
        .any(|bot| bot.id == settings.linkit_bot_id && bot.owner_user_id == user.id);
    if !owned {
        let grant = checked(
            request(state, bearer, reqwest::Method::POST, &["api", "bots"])?
                .json(&json!({"name":INTEGRATION_NAME}))
                .send()
                .await?,
            "create Bot",
        )?
        .json::<BotGrant>()
        .await?;
        return save_grant(state, user, settings, grant).await;
    }
    if !token_matches(state, settings).await? {
        let grant = checked(
            request(
                state,
                bearer,
                reqwest::Method::PATCH,
                &["api", "bots", &settings.linkit_bot_id],
            )?
            .json(&json!({"rotate_token":true}))
            .send()
            .await?,
            "rotate Bot token",
        )?
        .json::<BotGrant>()
        .await?;
        if grant.id != settings.linkit_bot_id {
            return Err(ApiError::unavailable("Linkit rotated a different Bot"));
        }
        save_grant(state, user, settings, grant).await?;
    }
    Ok(())
}

pub(super) async fn configure(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<NotificationStatus>, ApiError> {
    let _guard = lock_integrations(&state, format!("linkit:{}", identity.user.id)).await;
    let mut settings = user_db(&state, &identity.user, true, |connection| {
        integration_settings(connection)
    })
    .await?;
    let owner = checked(
        request(
            &state,
            &identity.bearer,
            reqwest::Method::GET,
            &["api", "me"],
        )?
        .send()
        .await?,
        "owner profile",
    )?
    .json::<Identity>()
    .await?;
    if owner.id != identity.user.id {
        return Err(ApiError::forbidden(
            "Linkit returned a different notification owner",
        ));
    }
    settings.linkit_username = owner
        .profile
        .map(|profile| profile.username)
        .filter(|username| !username.trim().is_empty())
        .ok_or_else(|| {
            ApiError::conflict("Set your Linkit username before enabling notifications")
        })?;
    repair_bot(&state, &identity.user, &identity.bearer, &mut settings).await?;
    save_settings(&state, &identity.user, &settings).await?;
    if !token_matches(&state, &settings).await? {
        return Err(ApiError::unavailable(
            "Linkit Bot credential changed during configuration; repair notifications again",
        ));
    }
    set_enabled(&state, &identity.user, true).await?;
    read(State(state), axum::Extension(identity)).await
}

async fn deliver(
    state: &AppState,
    user: &User,
    settings: &IntegrationSettings,
    body: &str,
) -> Result<DeliveryReceipt, ApiError> {
    if !configured(settings) {
        return Err(ApiError::conflict(
            "Configure Linkit notifications before sending a test message",
        ));
    }
    if !token_matches(state, settings).await? {
        return Err(ApiError::unavailable(
            "Linkit Bot token is invalid; configure or repair notifications",
        ));
    }
    let conversation = checked(
        request(
            state,
            &settings.linkit_bot_token,
            reqwest::Method::POST,
            &["api", "conversations", "direct", &settings.linkit_username],
        )?
        .send()
        .await?,
        "open direct conversation",
    )?
    .json::<DirectConversation>()
    .await?;
    // INVARIANT: A stored username can be renamed or reassigned in Linkit.
    // Confirm the stable recipient UUID before disclosing any Thread content.
    if conversation.id.is_empty()
        || conversation.kind != "direct"
        || conversation.counterpart_user_id.as_deref() != Some(user.id.as_str())
    {
        return Err(ApiError::forbidden(
            "Linkit notification recipient changed; repair notifications before sending",
        ));
    }
    let receipt = checked(
        request(
            state,
            &settings.linkit_bot_token,
            reqwest::Method::POST,
            &["api", "conversations", &conversation.id, "messages"],
        )?
        .json(&json!({"body":body,"attachment_ids":[],"urgent":false}))
        .send()
        .await?,
        "send message",
    )?
    .json::<DeliveryReceipt>()
    .await?;
    if receipt.id.is_empty()
        || receipt.conversation_id != conversation.id
        || receipt.sender_id != settings.linkit_bot_id
        || receipt.sender_kind != "bot"
    {
        return Err(ApiError::unavailable(
            "Linkit returned an invalid notification receipt",
        ));
    }
    Ok(receipt)
}

async fn record_delivery(
    state: &AppState,
    user: &User,
    result: &Result<DeliveryReceipt, ApiError>,
) -> Result<(), ApiError> {
    let (error, conversation, message) = match result {
        Ok(receipt) => (
            None,
            Some(receipt.conversation_id.clone()),
            Some(receipt.id.clone()),
        ),
        Err(error) => (Some(error.message.clone()), None, None),
    };
    user_db(state, user, true, move |connection| {
        let at = now();
        connection.execute(
            "UPDATE notification_settings SET last_attempt_at=?,last_error=?,
             last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,
             conversation_id=COALESCE(?,conversation_id),message_id=COALESCE(?,message_id) WHERE id=1",
            params![at,error,error,at,conversation,message],
        )?;
        Ok(())
    }).await
}

pub(super) async fn test(
    State(state): State<AppState>,
    axum::Extension(identity): axum::Extension<BrowserIdentity>,
) -> Result<Json<DeliveryReceipt>, ApiError> {
    let settings = user_db(&state, &identity.user, true, |connection| {
        integration_settings(connection)
    })
    .await?;
    let result = deliver(&state, &identity.user, &settings,
        "Cybion notification test / 通知测试\n\nThis verifies delivery to your Linkit conversation, not device push or read status.\n这条消息用于验证 Linkit 会话投递，不代表设备推送或已读。",
    ).await;
    record_delivery(&state, &identity.user, &result).await?;
    result.map(Json)
}

fn notification_body(thread: &ThreadView, completed: bool, detail: &str) -> String {
    let outcome = if completed {
        "completed / 已完成"
    } else {
        "failed / 失败"
    };
    format!(
        "Cybion {outcome} · {}\n\n{}\n\nhttps://cybion.ntnl.io/#/threads/{}",
        truncate(&thread.title, 300),
        truncate(detail, 2500),
        thread.id
    )
}

async fn notify_enabled(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    completed: bool,
    detail: &str,
) -> Result<(), ApiError> {
    let (settings, enabled) = user_db(state, user, false, |connection| {
        let enabled: bool = connection.query_row(
            "SELECT enabled FROM notification_settings WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok((integration_settings(connection)?, enabled))
    })
    .await?;
    if !enabled {
        return Ok(());
    }
    let result = deliver(
        state,
        user,
        &settings,
        &notification_body(thread, completed, detail),
    )
    .await;
    record_delivery(state, user, &result).await?;
    result.map(|_| ())
}

pub(super) async fn notify(
    state: &AppState,
    user: &User,
    thread: &ThreadView,
    completed: bool,
    detail: &str,
) {
    if let Err(error) = notify_enabled(state, user, thread, completed, detail).await {
        // RECOVERY: Notification delivery is a separate boundary. The Thread
        // outcome is already durable and must not be changed by notification failure.
        tracing::warn!(thread_id=%thread.id,error=%error.message,"Linkit notification failed");
    }
}

#[cfg(test)]
mod tests;
