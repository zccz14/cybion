use super::*;
use std::collections::{BTreeMap, VecDeque};

// Custom Tools: declarative controller-side integrations.
//
// A connector declares a base URL, credential references, and per-tool request
// bindings plus response projections. Routing, credential injection, request
// building, projection, settlement and rate limiting all live in this module;
// adding a connector must never require touching the dispatcher, the request
// builder or the recovery loop. The Linkit connector is the first declaration
// (see tools.json and docs: CUSTOM-TOOLS.md).

const STORE_CUSTOM: &str = "custom_tool_settings";
const STORE_INTEGRATION: &str = "integration_settings";
const DEFAULT_TIMEOUT_SECONDS: u64 = 15;
const MAX_TIMEOUT_SECONDS: u64 = 60;

#[derive(Debug, Deserialize, Clone)]
struct SecretRef {
    store: String,
    #[serde(default)]
    field: String,
    #[serde(default)]
    key: String,
}

#[derive(Debug, Deserialize)]
struct Auth {
    scheme: String,
    secret: SecretRef,
    #[serde(default)]
    name: String,
    #[serde(default)]
    param: String,
    #[serde(default)]
    format: String,
}

#[derive(Debug, Deserialize, Default)]
struct Limits {
    #[serde(default)]
    per_minute: u32,
}

#[derive(Debug, Deserialize)]
struct ResultSpec {
    projection: Value,
}

#[derive(Debug, Deserialize)]
struct Binding {
    method: String,
    path: String,
    #[serde(default)]
    path_params: Vec<String>,
    #[serde(default)]
    query: Vec<String>,
    #[serde(default)]
    body: Vec<String>,
    #[serde(default)]
    defaults: serde_json::Map<String, Value>,
    #[serde(default)]
    body_constants: serde_json::Map<String, Value>,
    effect: String,
    #[serde(default)]
    settlement: Option<Value>,
    result: ResultSpec,
    #[serde(default = "default_timeout")]
    timeout_seconds: u64,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

#[derive(Debug, Deserialize)]
struct Tool {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    description: String,
    parameters: Value,
    binding: Binding,
}

#[derive(Debug, Deserialize)]
struct Connector {
    base_url: String,
    auth: Auth,
    #[serde(default)]
    available_when: Vec<SecretRef>,
    #[serde(default)]
    limits: Limits,
    tools: Vec<Tool>,
}

struct Registry {
    connectors: BTreeMap<String, Connector>,
    routes: BTreeMap<String, String>,
}

// INVARIANT: the catalog is validated by `custom_tools_catalog_is_valid`; a
// malformed declaration fails the test suite instead of reaching production.
static REGISTRY: std::sync::LazyLock<Registry> = std::sync::LazyLock::new(|| {
    let raw = TOOL_CATALOG
        .get("custom_tools")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let connectors: BTreeMap<String, Connector> =
        serde_json::from_value(raw).expect("custom_tools declarations are valid");
    let mut routes = BTreeMap::new();
    for (id, connector) in &connectors {
        for tool in &connector.tools {
            routes.insert(tool.name.clone(), id.clone());
        }
    }
    Registry { connectors, routes }
});

/// Resolves a tool name to its connector id, if it belongs to Custom Tools.
pub(super) fn connector_of(name: &str) -> Option<&'static str> {
    REGISTRY.routes.get(name).map(String::as_str)
}

/// The connectors whose declared credentials are all present for this user.
/// The request builder injects only these tools, so the model never sees a
/// tool the user cannot use.
pub(super) async fn enabled_for(state: &AppState, user: &User) -> Result<Vec<String>, ApiError> {
    user_db(state, user, false, |connection| {
        let settings = integration_settings(connection)?;
        let mut enabled = Vec::new();
        for (id, connector) in &REGISTRY.connectors {
            let mut ready = true;
            for reference in &connector.available_when {
                if secret_value(connection, &settings, id, reference)?.is_none() {
                    ready = false;
                    break;
                }
            }
            if ready {
                enabled.push(id.clone());
            }
        }
        Ok(enabled)
    })
    .await
}

/// Model-facing schemas for the enabled connectors. Internal declaration
/// fields (titles, bindings) are stripped: only the function tool shape is
/// ever sent upstream.
pub(super) fn injected_tools(enabled: &[String]) -> Vec<Value> {
    let mut tools = Vec::new();
    for id in enabled {
        let Some(connector) = REGISTRY.connectors.get(id) else {
            continue;
        };
        for tool in &connector.tools {
            // INVARIANT: catalog validation pins every tool to `function`;
            // skipping keeps the model surface safe if a declaration slips.
            if tool.kind != "function" {
                continue;
            }
            tools.push(json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }));
        }
    }
    tools
}

fn secret_value(
    connection: &Connection,
    settings: &IntegrationSettings,
    connector_id: &str,
    reference: &SecretRef,
) -> Result<Option<String>, ApiError> {
    let value = match reference.store.as_str() {
        STORE_INTEGRATION => match reference.field.as_str() {
            "linkit_bot_id" => settings.linkit_bot_id.clone(),
            "linkit_bot_token" => settings.linkit_bot_token.clone(),
            "linkit_username" => settings.linkit_username.clone(),
            "ctx_api_key" => settings.ctx_api_key.clone(),
            "ctx_api_key_id" => settings.ctx_api_key_id.clone(),
            other => {
                return Err(ApiError::internal(format!(
                    "custom tool references an unknown integration_settings field: {other}"
                )));
            }
        },
        STORE_CUSTOM => {
            let values: Option<String> = connection
                .query_row(
                    "SELECT values_json FROM custom_tool_settings WHERE connector_id=?",
                    params![connector_id],
                    |row| row.get(0),
                )
                .optional()?;
            let values: Value = values
                .map(|raw| serde_json::from_str(&raw).map_err(ApiError::internal))
                .transpose()?
                .unwrap_or_else(|| json!({}));
            values
                .get(&reference.key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        }
        other => {
            return Err(ApiError::internal(format!(
                "custom tool references an unknown secret store: {other}"
            )));
        }
    };
    Ok((!value.trim().is_empty()).then_some(value))
}

async fn auth_secret(
    state: &AppState,
    user: &User,
    connector_id: &str,
    reference: &SecretRef,
) -> Result<Option<String>, ApiError> {
    let connector_id = connector_id.to_owned();
    let reference = reference.clone();
    user_db(state, user, false, move |connection| {
        let settings = integration_settings(connection)?;
        secret_value(connection, &settings, &connector_id, &reference)
    })
    .await
}

// Per-user sliding window rate limiting. In-memory is sufficient: the window
// only guards a single Controller process, and a restart merely forgives a
// user's in-flight window.
static RATE_LIMITS: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, VecDeque<i64>>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

async fn rate_allow(user_id: &str, connector_id: &str, per_minute: u32) -> bool {
    if per_minute == 0 {
        return true;
    }
    let key = format!("{user_id}:{connector_id}");
    let mut limits = RATE_LIMITS.lock().await;
    let window = limits.entry(key).or_default();
    let cutoff = now().saturating_sub(60);
    while window.front().is_some_and(|at| *at <= cutoff) {
        window.pop_front();
    }
    if window.len() as u32 >= per_minute {
        return false;
    }
    window.push_back(now());
    true
}

fn parse_arguments(tool: &Tool, input: &str) -> Result<serde_json::Map<String, Value>, String> {
    let value: Value = serde_json::from_str(input)
        .map_err(|error| format!("{} arguments must be valid JSON: {error}", tool.name))?;
    let Value::Object(arguments) = value else {
        return Err(format!("{} arguments must be a JSON object", tool.name));
    };
    let properties = tool
        .parameters
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in arguments.keys() {
        if !properties.contains_key(key) {
            return Err(format!("{} does not accept argument `{key}`", tool.name));
        }
    }
    if let Some(required) = tool.parameters.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !arguments.contains_key(key) {
                return Err(format!("{} requires argument `{key}`", tool.name));
            }
        }
    }
    for (key, argument) in &arguments {
        let kind = properties
            .get(key)
            .and_then(|property| property.get("type"))
            .and_then(Value::as_str);
        let ok = match kind {
            Some("string") => argument.is_string(),
            Some("integer") => argument.as_i64().is_some() || argument.as_u64().is_some(),
            Some("number") => argument.is_number(),
            Some("boolean") => argument.is_boolean(),
            Some("array") => argument.is_array(),
            Some("object") => argument.is_object(),
            _ => true,
        };
        if !ok {
            return Err(format!("{} argument `{key}` has the wrong type", tool.name));
        }
    }
    Ok(arguments)
}

fn argument_value<'a>(
    arguments: &'a serde_json::Map<String, Value>,
    binding: &'a Binding,
    key: &str,
) -> Option<&'a Value> {
    arguments.get(key).or_else(|| binding.defaults.get(key))
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

/// Percent-encodes one path segment. Rejects empty segments, control
/// characters, and the traversal segments `.` / `..`; everything else is
/// percent-encoded, so a value can never escape its declared path slot.
fn encode_segment(value: &str) -> Option<String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    if encoded == "." || encoded == ".." {
        return None;
    }
    Some(encoded)
}

/// `provider_key` settlements send the provider's idempotency header carrying
/// the model call id, which is stable across replays.
fn idempotency_header(binding: &Binding, call_id: &str) -> Option<(String, String)> {
    let settlement = binding.settlement.as_ref()?;
    if settlement.get("strategy").and_then(Value::as_str) != Some("provider_key") {
        return None;
    }
    let header = settlement
        .pointer("/idempotency/header")
        .and_then(Value::as_str)?;
    if settlement
        .pointer("/idempotency/value_from")
        .and_then(Value::as_str)
        != Some("call_id")
    {
        return None;
    }
    Some((header.to_owned(), call_id.to_owned()))
}

fn build_body(binding: &Binding, arguments: &serde_json::Map<String, Value>) -> Option<Value> {
    if binding.body.is_empty() && binding.body_constants.is_empty() {
        return None;
    }
    let mut body = serde_json::Map::new();
    for key in &binding.body {
        if let Some(value) = argument_value(arguments, binding, key) {
            body.insert(key.clone(), value.clone());
        }
    }
    for (key, value) in &binding.body_constants {
        body.insert(key.clone(), value.clone());
    }
    Some(Value::Object(body))
}

struct Prepared {
    method: reqwest::Method,
    url: url::Url,
    body: Option<Value>,
}

fn prepare_request(
    base_url: &str,
    connector: &Connector,
    binding: &Binding,
    arguments: &serde_json::Map<String, Value>,
    secret: &str,
) -> Result<Prepared, String> {
    let method = match binding.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("unsupported method `{other}`")),
    };
    let mut path = binding.path.clone();
    for parameter in &binding.path_params {
        let value = argument_value(arguments, binding, parameter)
            .and_then(scalar_string)
            .ok_or_else(|| format!("missing or invalid `{parameter}`"))?;
        let encoded = encode_segment(&value)
            .ok_or_else(|| format!("`{parameter}` is not allowed in a request path"))?;
        path = path.replace(&format!("{{{parameter}}}"), &encoded);
    }
    let mut url = url::Url::parse(&format!("{}{}", base_url.trim_end_matches('/'), path))
        .map_err(|_| "the request path could not be built".to_owned())?;
    {
        let mut query = url.query_pairs_mut();
        for parameter in &binding.query {
            if let Some(value) =
                argument_value(arguments, binding, parameter).and_then(scalar_string)
            {
                query.append_pair(parameter, &value);
            }
        }
        if connector.auth.scheme == "query" {
            query.append_pair(&connector.auth.param, secret);
        }
    }
    let body = build_body(binding, arguments);
    Ok(Prepared { method, url, body })
}

/// Response projection: only declared fields reach the model. Missing fields
/// are errors (fail closed); undeclared fields are dropped.
fn project(projection: &Value, response: &Value) -> Result<Value, String> {
    let map = projection
        .as_object()
        .ok_or_else(|| "projection must be an object".to_owned())?;
    let mut output = serde_json::Map::new();
    for (key, spec) in map {
        if let Some(path) = spec.as_str() {
            let value =
                pick_path(response, path).ok_or_else(|| format!("response is missing `{path}`"))?;
            output.insert(key.clone(), value.clone());
        } else if let Some(list) = spec.get("list").and_then(Value::as_str) {
            let items =
                pick_path(response, list).ok_or_else(|| format!("response is missing `{list}`"))?;
            let items = items
                .as_array()
                .ok_or_else(|| format!("response `{list}` is not an array"))?;
            let pick = spec
                .get("pick")
                .and_then(Value::as_object)
                .ok_or_else(|| "a list projection needs `pick`".to_owned())?;
            let mut picked = Vec::with_capacity(items.len());
            for item in items {
                let mut entry = serde_json::Map::new();
                for (field, path) in pick {
                    let path = path
                        .as_str()
                        .ok_or_else(|| "pick paths must be strings".to_owned())?;
                    let value = pick_path(item, path)
                        .ok_or_else(|| format!("response item is missing `{path}`"))?;
                    entry.insert(field.clone(), value.clone());
                }
                picked.push(Value::Object(entry));
            }
            output.insert(key.clone(), Value::Array(picked));
        } else {
            return Err(format!("projection `{key}` is not a supported form"));
        }
    }
    Ok(Value::Object(output))
}

fn pick_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

enum Settlement {
    Execute,
    Reuse(Value),
    Unknown,
    Failed(String),
}

/// Marks the call before any side effect. The unique dedupe index plus the
/// status transitions make replays (recovery, crash windows) deterministic:
/// a `sent`/`completed` call is reused, a `sending` call is an unknown
/// outcome, and a failed read may be retried.
#[allow(clippy::too_many_arguments)]
async fn settle_begin(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input_record_id: i64,
    call_id: &str,
    connector_id: &str,
    tool: &str,
    effect: &str,
    input: &str,
) -> Result<Settlement, ApiError> {
    let thread_id = thread_id.to_owned();
    let call_id = call_id.to_owned();
    let connector_id = connector_id.to_owned();
    let tool = tool.to_owned();
    let effect = effect.to_owned();
    let input = input.to_owned();
    user_db(state, user, false, move |connection| {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT status,result_json FROM custom_tool_calls WHERE thread_id=? AND input_record_id=? AND responses_call_id=?",
                params![thread_id, input_record_id, call_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let settlement = if let Some((status, result)) = existing {
            let result = result
                .map(|raw| serde_json::from_str::<Value>(&raw).map_err(ApiError::internal))
                .transpose()?;
            match status.as_str() {
                "sent" | "completed" => match result {
                    Some(result) => Settlement::Reuse(result),
                    None => Settlement::Unknown,
                },
                "sending" => Settlement::Unknown,
                "failed" => {
                    if effect == "read" {
                        Settlement::Execute
                    } else {
                        let message = result
                            .as_ref()
                            .and_then(|value| value.get("error"))
                            .and_then(Value::as_str)
                            .unwrap_or("the send failed")
                            .to_owned();
                        Settlement::Failed(message)
                    }
                }
                "running" => Settlement::Execute,
                _ => Settlement::Unknown,
            }
        } else {
            transaction.execute(
                "INSERT INTO custom_tool_calls(id,connector_id,tool,thread_id,input_record_id,responses_call_id,effect,status,arguments_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                params![
                    Uuid::new_v4().to_string(),
                    connector_id,
                    tool,
                    thread_id,
                    input_record_id,
                    call_id,
                    effect,
                    if effect == "send" { "sending" } else { "running" },
                    input,
                    now()
                ],
            )?;
            Settlement::Execute
        };
        transaction.commit()?;
        Ok(settlement)
    })
    .await
}

async fn settle_finish(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input_record_id: i64,
    call_id: &str,
    status: &str,
    result: Option<Value>,
) -> Result<(), ApiError> {
    let thread_id = thread_id.to_owned();
    let call_id = call_id.to_owned();
    let status = status.to_owned();
    let result_json = result.map(|value| value.to_string());
    user_db(state, user, false, move |connection| {
        connection.execute(
            "UPDATE custom_tool_calls SET status=?, result_json=?, completed_at=? WHERE thread_id=? AND input_record_id=? AND responses_call_id=?",
            params![status, result_json, now(), thread_id, input_record_id, call_id],
        )?;
        Ok(())
    })
    .await
}

fn unknown_outcome(name: &str, detail: &str) -> Value {
    json!({
        "error": format!(
            "{name} has an unknown outcome: {detail}. The operation may or may not have executed; verify the current state (for example by reading recent data back) before retrying, and do not blindly resend."
        ),
        "execution_outcome": "unknown",
    })
}

enum Outcome {
    Delivered(Value),
    Failed(String),
    Ambiguous(String),
}

/// Executes one Custom Tool call and returns the value that will be recorded
/// as the tool output. Model-facing failures (rejections, unknown outcomes,
/// configuration errors) return `Ok` with an `error` object so the model can
/// self-correct; storage failures return `Err` and abort the turn.
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input_record_id: i64,
    call_id: &str,
    connector_id: &str,
    name: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let Some(connector) = REGISTRY.connectors.get(connector_id) else {
        return Ok(json!({"error": format!("unsupported tool: {name}")}));
    };
    let Some(tool) = connector.tools.iter().find(|tool| tool.name == name) else {
        return Ok(json!({"error": format!("unsupported tool: {name}")}));
    };
    let binding = &tool.binding;
    let effect = binding.effect.as_str();
    if effect == "send" && binding.settlement.is_none() {
        return Ok(
            json!({"error": format!("{name} is misconfigured: send tools need a settlement strategy")}),
        );
    }
    let arguments = match parse_arguments(tool, input) {
        Ok(arguments) => arguments,
        Err(message) => return Ok(json!({ "error": message })),
    };
    let secret = match auth_secret(state, user, connector_id, &connector.auth.secret).await? {
        Some(secret) => secret,
        None => return Ok(json!({"error": format!("{name} is not configured")})),
    };
    if !rate_allow(&user.id, connector_id, connector.limits.per_minute).await {
        return Ok(json!({"error": format!("{name} is rate limited; try again later")}));
    }
    let base_url = {
        let overrides = state.custom_tool_base_urls.lock().await;
        overrides
            .get(connector_id)
            .cloned()
            .unwrap_or_else(|| connector.base_url.clone())
    };
    let prepared = match prepare_request(&base_url, connector, binding, &arguments, &secret) {
        Ok(prepared) => prepared,
        Err(message) => return Ok(json!({"error": format!("{name}: {message}")})),
    };
    match settle_begin(
        state,
        user,
        thread_id,
        input_record_id,
        call_id,
        connector_id,
        name,
        effect,
        input,
    )
    .await?
    {
        Settlement::Execute => {}
        Settlement::Reuse(result) => return Ok(result),
        Settlement::Unknown => {
            return Ok(unknown_outcome(
                name,
                "an earlier attempt did not record a result",
            ));
        }
        Settlement::Failed(message) => return Ok(json!({ "error": message })),
    }
    let idempotency = idempotency_header(binding, call_id);
    let timeout = Duration::from_secs(binding.timeout_seconds.clamp(1, MAX_TIMEOUT_SECONDS));
    let attempts = if effect == "read" { 2 } else { 1 };
    let mut outcome = None;
    for attempt in 0..attempts {
        let mut request = state
            .client
            .request(prepared.method.clone(), prepared.url.clone())
            .timeout(timeout);
        request = match connector.auth.scheme.as_str() {
            "bearer" => request.bearer_auth(&secret),
            "header" => {
                let header = if connector.auth.name.is_empty() {
                    "Authorization"
                } else {
                    connector.auth.name.as_str()
                };
                let value = if connector.auth.format.is_empty() {
                    secret.clone()
                } else {
                    connector.auth.format.replace("{secret}", &secret)
                };
                request.header(header, value)
            }
            _ => request,
        };
        if let Some((header, value)) = &idempotency {
            request = request.header(header, value);
        }
        if let Some(body) = &prepared.body {
            request = request.json(body);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let raw = response.bytes().await.ok().and_then(|bytes| {
                        if bytes.is_empty() {
                            Some(json!({}))
                        } else {
                            serde_json::from_slice::<Value>(&bytes).ok()
                        }
                    });
                    match raw {
                        Some(raw) => match project(&binding.result.projection, &raw) {
                            Ok(projected) => {
                                outcome = Some(Outcome::Delivered(projected));
                                break;
                            }
                            Err(message) => {
                                outcome = Some(Outcome::Delivered(json!({
                                    "error": if effect == "send" {
                                        format!("{name} completed but its response did not match the declared projection ({message}); do not resend")
                                    } else {
                                        format!("{name} returned a response that did not match the declared projection ({message})")
                                    },
                                })));
                                break;
                            }
                        },
                        None => {
                            if effect == "read" && attempt + 1 < attempts {
                                continue;
                            }
                            outcome = Some(if effect == "read" {
                                Outcome::Failed(format!("{name} returned an unreadable response"))
                            } else {
                                Outcome::Ambiguous(format!(
                                    "{name} may have executed: its response could not be read"
                                ))
                            });
                            break;
                        }
                    }
                } else if status.is_client_error() {
                    outcome = Some(Outcome::Failed(format!(
                        "{name} was rejected (HTTP {})",
                        status.as_u16()
                    )));
                    break;
                } else {
                    if effect == "read" && attempt + 1 < attempts {
                        continue;
                    }
                    outcome = Some(if effect == "read" {
                        Outcome::Failed(format!(
                            "{name} is temporarily unavailable (HTTP {})",
                            status.as_u16()
                        ))
                    } else {
                        Outcome::Ambiguous(format!(
                            "{name} may have executed: the service returned HTTP {}",
                            status.as_u16()
                        ))
                    });
                    break;
                }
            }
            Err(error) => {
                // Never surface transport error strings: they can embed the
                // request URL, and query-style credentials ride in the URL.
                tracing::warn!(
                    connector = connector_id,
                    tool = name,
                    timeout = error.is_timeout(),
                    connect = error.is_connect(),
                    "custom tool transport failure"
                );
                if effect == "read" && attempt + 1 < attempts {
                    continue;
                }
                outcome = Some(if effect == "read" {
                    Outcome::Failed(format!("{name} is temporarily unavailable (network error)"))
                } else {
                    Outcome::Ambiguous(format!(
                        "{name} may have executed: the request did not complete (network error)"
                    ))
                });
                break;
            }
        }
    }
    let outcome = outcome.expect("the send loop always settles an outcome");
    let output = match outcome {
        Outcome::Delivered(result) => {
            let status = if effect == "send" {
                "sent"
            } else {
                "completed"
            };
            settle_finish(
                state,
                user,
                thread_id,
                input_record_id,
                call_id,
                status,
                Some(result.clone()),
            )
            .await?;
            result
        }
        Outcome::Failed(message) => {
            settle_finish(
                state,
                user,
                thread_id,
                input_record_id,
                call_id,
                "failed",
                Some(json!({ "error": message.clone() })),
            )
            .await?;
            json!({ "error": message })
        }
        Outcome::Ambiguous(detail) => {
            // The row stays in `sending`: recovery rules on it conservatively.
            unknown_outcome(name, &detail)
        }
    };
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::super::tests::test_state;
    use super::*;

    struct Fixture {
        _root: tempfile::TempDir,
        state: AppState,
        user: User,
        calls: Arc<Mutex<Vec<Value>>>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn mock_tool(State(calls): State<Arc<Mutex<Vec<Value>>>>, request: Request) -> Response {
        let method = request.method().to_string();
        let path = request.uri().path().to_owned();
        let authorization = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        calls.lock().await.push(json!({
            "method": method,
            "path": path,
            "authorization": authorization,
            "body": body,
        }));
        Json(json!({"id": "message-1", "conversation_id": "conversation-1"})).into_response()
    }

    async fn fixture() -> Fixture {
        let (root, state) = test_state();
        let user = user_for_subject(&state, "custom-tools-owner").unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(mock_tool).with_state(calls.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        state
            .custom_tool_base_urls
            .lock()
            .await
            .insert("linkit".to_owned(), base);
        user_db(&state, &user, true, move |connection| {
            connection.execute(
                "INSERT INTO integration_settings(id,linkit_bot_id,linkit_bot_token,linkit_username,updated_at)
                 VALUES(1,'bot-1','sk-bot-token','owner',1)
                 ON CONFLICT(id) DO UPDATE SET linkit_bot_id='bot-1',linkit_bot_token='sk-bot-token',linkit_username='owner'",
                [],
            )?;
            connection.execute(
                "INSERT INTO threads(id,title,model,status,created_at,updated_at)
                 VALUES('thread-1','Custom tools fixture','test-model','idle',1,1)",
                [],
            )?;
            connection.execute(
                "INSERT INTO history_records(thread_id,kind,payload,created_at)
                 VALUES('thread-1','input','{}',1)",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        Fixture {
            _root: root,
            state,
            user,
            calls,
            server,
        }
    }

    #[test]
    fn custom_tools_catalog_is_valid() {
        let mut names: std::collections::BTreeSet<String> = [
            "read_context",
            "cybion_list_contexts",
            "cybion_list_workers",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        for tool in TOOL_CATALOG["worker"].as_array().unwrap() {
            names.insert(tool["name"].as_str().unwrap().to_owned());
        }
        for (id, connector) in &REGISTRY.connectors {
            assert!(
                connector.base_url.starts_with("https://")
                    || connector.base_url.starts_with("http://"),
                "{id} needs an absolute base_url"
            );
            assert!(!connector.tools.is_empty(), "{id} declares no tools");
            assert!(matches!(
                connector.auth.scheme.as_str(),
                "bearer" | "header" | "query"
            ));
            for reference in &connector.available_when {
                assert!(matches!(
                    reference.store.as_str(),
                    "integration_settings" | "custom_tool_settings"
                ));
            }
            for tool in &connector.tools {
                assert_eq!(tool.kind, "function");
                assert!(
                    tool.name.starts_with(&format!("{id}_")),
                    "{} must be prefixed with `{id}_`",
                    tool.name
                );
                assert!(
                    names.insert(tool.name.clone()),
                    "duplicate tool name {}",
                    tool.name
                );
                let binding = &tool.binding;
                assert!(binding.path.starts_with('/') && !binding.path.contains("://"));
                assert!(matches!(
                    binding.method.as_str(),
                    "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
                ));
                assert!(matches!(binding.effect.as_str(), "read" | "send"));
                if binding.effect == "send" {
                    assert!(
                        binding.settlement.is_some(),
                        "{} must declare a settlement strategy",
                        tool.name
                    );
                }
                assert!((1..=MAX_TIMEOUT_SECONDS).contains(&binding.timeout_seconds));
                assert!(
                    binding
                        .result
                        .projection
                        .as_object()
                        .is_some_and(|projection| !projection.is_empty()),
                    "{} needs a response projection",
                    tool.name
                );
                let properties = tool.parameters["properties"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                for parameter in properties.keys() {
                    let placements = usize::from(binding.path_params.contains(parameter))
                        + usize::from(binding.query.contains(parameter))
                        + usize::from(binding.body.contains(parameter));
                    assert_eq!(
                        placements, 1,
                        "{} parameter `{parameter}` must be bound exactly once",
                        tool.name
                    );
                }
                for parameter in binding
                    .path_params
                    .iter()
                    .chain(&binding.query)
                    .chain(&binding.body)
                {
                    assert!(
                        properties.contains_key(parameter),
                        "{} binds undeclared parameter `{parameter}`",
                        tool.name
                    );
                }
                for segment in binding.path.split('/') {
                    if let Some(inner) = segment
                        .strip_prefix('{')
                        .and_then(|segment| segment.strip_suffix('}'))
                    {
                        assert!(
                            binding.path_params.contains(&inner.to_owned()),
                            "{} path placeholder `{inner}` is not a path parameter",
                            tool.name
                        );
                    }
                }
            }
        }
        assert!(REGISTRY.connectors.contains_key("linkit"));
    }

    #[test]
    fn encode_segment_constrains_path_slots() {
        assert_eq!(encode_segment("a b/c").unwrap(), "a%20b%2Fc");
        assert_eq!(encode_segment("ok-1_2.~").unwrap(), "ok-1_2.~");
        assert!(encode_segment("").is_none());
        assert!(encode_segment(".").is_none());
        assert!(encode_segment("..").is_none());
        assert!(encode_segment("line\nbreak").is_none());
    }

    #[test]
    fn projection_picks_declared_fields_only() {
        let projection = json!({
            "message_id": "id",
            "conversations": {
                "list": "conversations",
                "pick": { "id": "id", "kind": "kind" }
            }
        });
        let response = json!({
            "id": "m1",
            "secret": "nope",
            "conversations": [
                { "id": "c1", "kind": "direct", "secret": "x" },
                { "id": "c2", "kind": "group" }
            ]
        });
        assert_eq!(
            project(&projection, &response).unwrap(),
            json!({
                "message_id": "m1",
                "conversations": [
                    { "id": "c1", "kind": "direct" },
                    { "id": "c2", "kind": "group" }
                ]
            })
        );
        assert!(project(&json!({"x": "missing"}), &response).is_err());
        assert!(
            project(
                &json!({"x": {"list": "conversations", "pick": {"id": "nope"}}}),
                &response
            )
            .is_err()
        );
    }

    #[test]
    fn provider_idempotency_keys_use_the_call_id() {
        let provider_key: Binding = serde_json::from_value(json!({
            "method": "POST", "path": "/notes", "body": [], "effect": "send",
            "settlement": {"strategy": "provider_key",
                "idempotency": {"header": "Idempotency-Key", "value_from": "call_id"}},
            "result": {"projection": {"id": "id"}}
        }))
        .unwrap();
        assert_eq!(
            idempotency_header(&provider_key, "call-9"),
            Some(("Idempotency-Key".to_owned(), "call-9".to_owned()))
        );
        let mark_then_send: Binding = serde_json::from_value(json!({
            "method": "POST", "path": "/notes", "body": [], "effect": "send",
            "settlement": {"strategy": "mark_then_send"},
            "result": {"projection": {"id": "id"}}
        }))
        .unwrap();
        assert!(idempotency_header(&mark_then_send, "call-9").is_none());
    }

    #[test]
    fn arguments_are_validated_against_the_schema() {
        let tool = REGISTRY.connectors["linkit"]
            .tools
            .iter()
            .find(|tool| tool.name == "linkit_send_message")
            .unwrap();
        assert!(parse_arguments(tool, r#"{"conversation_id":"c","body":"hi"}"#).is_ok());
        assert!(parse_arguments(tool, r#"{"conversation_id":"c","body":"hi","extra":1}"#).is_err());
        assert!(parse_arguments(tool, r#"{"body":"hi"}"#).is_err());
        assert!(parse_arguments(tool, r#"{"conversation_id":"c","body":5}"#).is_err());
        assert!(parse_arguments(tool, "not json").is_err());
    }

    #[tokio::test]
    async fn tool_surface_follows_configured_credentials() {
        let f = fixture().await;
        assert_eq!(connector_of("linkit_send_message"), Some("linkit"));
        assert_eq!(connector_of("bash"), None);
        assert_eq!(connector_of("unknown_tool"), None);
        let enabled = enabled_for(&f.state, &f.user).await.unwrap();
        assert!(enabled.contains(&"linkit".to_owned()));
        let tools = injected_tools(&enabled);
        assert_eq!(
            tools
                .iter()
                .filter(|tool| tool["name"].as_str().unwrap().starts_with("linkit_"))
                .count(),
            4
        );
        assert!(
            tools
                .iter()
                .all(|tool| tool.get("binding").is_none() && tool.get("title").is_none())
        );
        user_db(&f.state, &f.user, false, |connection| {
            connection.execute(
                "UPDATE integration_settings SET linkit_bot_token='' WHERE id=1",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        assert!(enabled_for(&f.state, &f.user).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn send_executes_once_and_replays_are_reused() {
        let f = fixture().await;
        let input = r#"{"conversation_id":"conversation-1","body":"hello"}"#;
        let output = execute(
            &f.state,
            &f.user,
            "thread-1",
            1,
            "call-1",
            "linkit",
            "linkit_send_message",
            input,
        )
        .await
        .unwrap();
        assert_eq!(
            output,
            json!({"message_id":"message-1","conversation_id":"conversation-1"})
        );
        let replay = execute(
            &f.state,
            &f.user,
            "thread-1",
            1,
            "call-1",
            "linkit",
            "linkit_send_message",
            input,
        )
        .await
        .unwrap();
        assert_eq!(replay, output);
        let calls = f.calls.lock().await;
        assert_eq!(
            calls.len(),
            1,
            "a replayed call must not hit the service twice"
        );
        assert_eq!(calls[0]["method"], "POST");
        assert_eq!(
            calls[0]["path"],
            "/api/conversations/conversation-1/messages"
        );
        assert_eq!(calls[0]["authorization"], "Bearer sk-bot-token");
        assert_eq!(
            calls[0]["body"],
            json!({"body":"hello","urgent":false,"attachment_ids":[]})
        );
        drop(calls);
        let row: (String, Option<String>) = open_user(&f.user.path, false)
            .unwrap()
            .query_row(
                "SELECT status,result_json FROM custom_tool_calls WHERE responses_call_id='call-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "sent");
        assert!(row.1.unwrap().contains("message-1"));
    }

    #[tokio::test]
    async fn sending_rows_are_unknown_outcomes_and_never_replay() {
        let f = fixture().await;
        user_db(&f.state, &f.user, false, |connection| {
            connection.execute(
                "INSERT INTO custom_tool_calls(id,connector_id,tool,thread_id,input_record_id,responses_call_id,effect,status,arguments_json,created_at)
                 VALUES('row-1','linkit','linkit_send_message','thread-1',1,'call-2','send','sending','{}',1)",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
        let output = execute(
            &f.state,
            &f.user,
            "thread-1",
            1,
            "call-2",
            "linkit",
            "linkit_send_message",
            r#"{"conversation_id":"conversation-1","body":"hi"}"#,
        )
        .await
        .unwrap();
        assert_eq!(output["execution_outcome"], "unknown");
        assert!(f.calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn append_tool_output_item_reuses_and_backfills_custom_tool_calls() {
        let f = fixture().await;
        let output = execute(
            &f.state,
            &f.user,
            "thread-1",
            1,
            "call-3",
            "linkit",
            "linkit_send_message",
            r#"{"conversation_id":"conversation-1","body":"hi"}"#,
        )
        .await
        .unwrap();
        let thread = load_thread(&open_user(&f.user.path, false).unwrap(), "thread-1").unwrap();
        let item = json!({
            "type": "function_call_output",
            "call_id": "call-3",
            "output": serde_json::to_string(&output).unwrap(),
        });
        let first = append_tool_output_item(&f.state, &f.user, &thread, 1, &item)
            .await
            .unwrap();
        let second = append_tool_output_item(&f.state, &f.user, &thread, 1, &item)
            .await
            .unwrap();
        assert_eq!(first, second);
        let backfilled: Option<i64> = open_user(&f.user.path, false)
            .unwrap()
            .query_row(
                "SELECT output_record_id FROM custom_tool_calls WHERE responses_call_id='call-3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backfilled, Some(first));
    }
}
