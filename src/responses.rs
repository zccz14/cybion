//! Responses SSE -> semantic events -> Thread state.
//! Behavioral reference: openai/codex a592c38c16cdd7623dacc9168926ebccedfb67d3.
mod items;
mod metadata;
mod rate_limits;
mod state;
#[cfg(test)]
mod tests;

pub(crate) use items::*;
pub(crate) use metadata::*;
pub(crate) use state::ResponseState;

use eventsource_stream::Eventsource;
use futures_util::{Stream, StreamExt};
use reqwest::{Response, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt::Display, pin::Pin, time::Duration};
use tokio::{sync::watch, time::timeout};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ResponseCompleted {
    pub(crate) id: String,
    pub(crate) usage: Option<Usage>,
    pub(crate) usage_metadata: Option<UsageMetadata>,
    pub(crate) end_turn: Option<bool>,
    #[serde(flatten)]
    pub(crate) extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub(crate) enum ResponseEvent {
    Created {
        response_id: Option<String>,
    },
    OutputItemAdded(ResponseItem),
    OutputItemDone(ResponseItem),
    OutputTextDelta {
        delta: String,
        item_id: Option<String>,
        content_index: Option<i64>,
    },
    ToolCallInputDelta {
        item_id: String,
        call_id: Option<String>,
        delta: String,
    },
    ReasoningSummaryDelta {
        delta: String,
        summary_index: i64,
        item_id: Option<String>,
    },
    ReasoningSummaryDone {
        item_id: String,
        text: String,
        summary_index: i64,
    },
    ReasoningContentDelta {
        delta: String,
        content_index: i64,
        item_id: Option<String>,
    },
    ReasoningSummaryPartAdded {
        summary_index: i64,
        item_id: Option<String>,
    },
    Completed(ResponseCompleted),
    ServerModel(String),
    ModelVerifications(Vec<ModelVerification>),
    TurnModerationMetadata(Value),
    ServerReasoningIncluded(bool),
    SafetyBuffering(SafetyBuffering),
    RateLimits(RateLimitSnapshot),
    ModelsEtag(String),
    TurnState(String),
    RequestId(String),
    // Cybion's provider can omit the final argument/text in item.done. These
    // typed updates retain the existing provider contract alongside Codex events.
    FunctionCallArgumentsDelta {
        item_id: String,
        delta: String,
    },
    FunctionCallArgumentsDone {
        item_id: String,
        arguments: String,
    },
    ToolCallInputDone {
        item_id: String,
        input: String,
    },
    OutputTextDone {
        item_id: Option<String>,
        content_index: Option<i64>,
        text: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub(crate) enum ResponsesStreamError {
    Cancelled,
    Timeout,
    Closed,
    Sse(String),
    InvalidPayload(String),
    ContextOverflow(String),
    QuotaExceeded(String),
    UsageNotIncluded(String),
    CyberPolicy(String),
    MisalignmentPolicy {
        message: String,
        details: Option<Value>,
    },
    InvalidRequest(String),
    ServerOverloaded(String),
    RateLimitExceeded {
        message: String,
        retry_after_ms: Option<u64>,
    },
    Retryable {
        message: String,
        retry_after_ms: Option<u64>,
    },
    Protocol(String),
}

impl Display for ResponsesStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("request superseded by a newer input"),
            Self::Timeout => f.write_str("idle timeout waiting for SSE"),
            Self::Closed => f.write_str("stream closed before response.completed"),
            Self::Sse(s)
            | Self::InvalidPayload(s)
            | Self::ContextOverflow(s)
            | Self::QuotaExceeded(s)
            | Self::UsageNotIncluded(s)
            | Self::CyberPolicy(s)
            | Self::InvalidRequest(s)
            | Self::ServerOverloaded(s)
            | Self::Protocol(s) => f.write_str(s),
            Self::MisalignmentPolicy { message, .. }
            | Self::RateLimitExceeded { message, .. }
            | Self::Retryable { message, .. } => f.write_str(message),
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpstreamError {
    code: Option<String>,
    message: Option<String>,
    misalignment: Option<Value>,
}

fn upstream_failure(value: &Value) -> ResponsesStreamError {
    let error = value
        .pointer("/response/error")
        .or_else(|| value.get("error"))
        .or_else(|| (value.get("type").and_then(Value::as_str) == Some("error")).then_some(value));
    let Some(error) = error.and_then(|v| serde_json::from_value::<UpstreamError>(v.clone()).ok())
    else {
        return ResponsesStreamError::Protocol("response.failed event received".to_owned());
    };
    let message = error.message.unwrap_or_default();
    match error.code.as_deref() {
        Some("context_length_exceeded" | "context_window_exceeded") => {
            ResponsesStreamError::ContextOverflow(message)
        }
        Some("insufficient_quota") => ResponsesStreamError::QuotaExceeded(message),
        Some("usage_not_included") => ResponsesStreamError::UsageNotIncluded(message),
        Some("cyber_policy") => ResponsesStreamError::CyberPolicy(if message.trim().is_empty() {
            "This request has been flagged for possible cybersecurity risk.".to_owned()
        } else {
            message
        }),
        Some("misalignment_policy_violation") => ResponsesStreamError::MisalignmentPolicy {
            message: if message.trim().is_empty() {
                "This request was blocked due to a misalignment policy violation.".to_owned()
            } else {
                message
            },
            details: error.misalignment,
        },
        Some("invalid_prompt" | "bio_policy") => ResponsesStreamError::InvalidRequest(message),
        Some("server_is_overloaded" | "slow_down") => {
            ResponsesStreamError::ServerOverloaded(message)
        }
        Some("rate_limit_exceeded") => ResponsesStreamError::RateLimitExceeded {
            retry_after_ms: retry_after_ms(&message),
            message,
        },
        _ => ResponsesStreamError::Retryable {
            message,
            retry_after_ms: None,
        },
    }
}

fn retry_after_ms(message: &str) -> Option<u64> {
    let message = message.to_ascii_lowercase();
    let (_, rest) = message.split_once("try again in")?;
    let rest = rest.trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let value = rest[..end].parse::<f64>().ok()?;
    let unit = rest[end..].trim_start();
    let millis = if unit.starts_with("ms") {
        value
    } else if unit.starts_with('s') {
        value * 1000.0
    } else {
        return None;
    };
    (millis.is_finite() && millis >= 0.0).then_some(millis as u64)
}

#[derive(Debug, Deserialize, PartialEq)]
enum WireEventType {
    #[serde(rename = "response.created")]
    Created,
    #[serde(rename = "response.output_item.added")]
    OutputItemAdded,
    #[serde(rename = "response.output_item.done")]
    OutputItemDone,
    #[serde(rename = "response.output_text.delta")]
    OutputTextDelta,
    #[serde(rename = "response.custom_tool_call_input.delta")]
    CustomToolCallInputDelta,
    #[serde(rename = "response.reasoning_summary_text.delta")]
    ReasoningSummaryTextDelta,
    #[serde(rename = "response.reasoning_summary_text.done")]
    ReasoningSummaryTextDone,
    #[serde(rename = "response.reasoning_text.delta")]
    ReasoningTextDelta,
    #[serde(rename = "response.reasoning_summary_part.added")]
    ReasoningSummaryPartAdded,
    #[serde(rename = "response.completed")]
    Completed,
    #[serde(rename = "response.failed")]
    Failed,
    #[serde(rename = "response.incomplete")]
    Incomplete,
    #[serde(rename = "response.metadata")]
    Metadata,
    #[serde(rename = "response.function_call_arguments.delta")]
    FunctionCallArgumentsDelta,
    #[serde(rename = "response.function_call_arguments.done")]
    FunctionCallArgumentsDone,
    #[serde(rename = "response.custom_tool_call_input.done")]
    CustomToolCallInputDone,
    #[serde(rename = "response.output_text.done")]
    OutputTextDone,
    #[serde(rename = "response.reasoning_summary_part.done")]
    ReasoningSummaryPartDone,
    #[serde(rename = "response.content_part.added")]
    ContentPartAdded,
    #[serde(rename = "response.content_part.done")]
    ContentPartDone,
    #[serde(rename = "response.in_progress")]
    InProgress,
    #[serde(rename = "codex.response.metadata")]
    CodexMetadata,
    #[serde(rename = "responsesapi.websocket_timing")]
    WebsocketTiming,
    #[serde(rename = "response.new_tool_event")]
    NewToolEvent,
    #[serde(rename = "response.refusal.delta")]
    RefusalDelta,
    #[serde(rename = "response.mcp_call_arguments.delta")]
    McpCallArgumentsDelta,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "codex.rate_limits")]
    RateLimits,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct WireEvent {
    #[serde(rename = "type")]
    kind: WireEventType,
    headers: Option<Value>,
    metadata: Option<Value>,
    response: Option<Value>,
    item: Option<Value>,
    item_id: Option<String>,
    call_id: Option<String>,
    delta: Option<String>,
    text: Option<String>,
    arguments: Option<String>,
    input: Option<String>,
    summary_index: Option<i64>,
    content_index: Option<i64>,
    #[serde(default, deserialize_with = "present_value")]
    safety_buffering: Option<Value>,
}

fn present_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

fn json_header(headers: Option<&Value>, names: &[&str]) -> Option<String> {
    fn string(value: &Value) -> Option<String> {
        match value {
            Value::String(s) => Some(s.clone()),
            Value::Array(a) => a.first().and_then(string),
            _ => None,
        }
    }
    headers?.as_object()?.iter().find_map(|(key, value)| {
        names
            .iter()
            .any(|name| key.eq_ignore_ascii_case(name))
            .then(|| string(value))
            .flatten()
    })
}

#[derive(Default)]
struct EventDecoder {
    last_model: Option<String>,
    faster_model: Option<String>,
}

impl EventDecoder {
    fn metadata(&mut self, event: &WireEvent) -> Vec<ResponseEvent> {
        let mut events = Vec::new();
        let model = json_header(
            event.response.as_ref().and_then(|r| r.get("headers")),
            &["openai-model", "x-openai-model"],
        )
        .or_else(|| json_header(event.headers.as_ref(), &["openai-model", "x-openai-model"]));
        if let Some(model) = model
            && self.last_model.as_ref() != Some(&model)
        {
            self.last_model = Some(model.clone());
            events.push(ResponseEvent::ServerModel(model));
        }
        if event.kind == WireEventType::Metadata {
            if let Some(state) = json_header(event.headers.as_ref(), &["x-codex-turn-state"]) {
                events.push(ResponseEvent::TurnState(state));
            }
            if let Some(metadata) = event.metadata.as_ref() {
                if metadata
                    .get("openai_verification_recommendation")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values
                            .iter()
                            .any(|v| v.as_str() == Some("trusted_access_for_cyber"))
                    })
                {
                    events.push(ResponseEvent::ModelVerifications(vec![
                        ModelVerification::TrustedAccessForCyber,
                    ]));
                }
                if let Some(moderation) = metadata.get("openai_chatgpt_moderation_metadata") {
                    events.push(ResponseEvent::TurnModerationMetadata(moderation.clone()));
                }
            }
        }
        let safety = event.safety_buffering.as_ref().or_else(|| {
            if event.kind != WireEventType::Metadata {
                return None;
            }
            event
                .metadata
                .as_ref()
                .filter(|m| m.get("type").and_then(Value::as_str) == Some("safety_buffering"))
        });
        if let Some(safety) = safety
            && let Ok(mut buffering) = serde_json::from_value::<SafetyBuffering>(safety.clone())
        {
            buffering.show_buffering_ui = true;
            if safety.get("retry_model").is_none() {
                buffering.faster_model.clone_from(&self.faster_model);
            }
            events.push(ResponseEvent::SafetyBuffering(buffering));
        }
        events
    }

    fn decode(
        &mut self,
        data: &str,
    ) -> Result<(Vec<ResponseEvent>, Option<ResponsesStreamError>), serde_json::Error> {
        let event: WireEvent = serde_json::from_str(data)?;
        let mut events = self.metadata(&event);
        let mut error = None;
        let semantic =
            match event.kind {
                WireEventType::Created => event.response.map(|response| ResponseEvent::Created {
                    response_id: response
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }),
                WireEventType::OutputItemAdded | WireEventType::OutputItemDone => event
                    .item
                    .and_then(|item| match ResponseItem::from_value(item) {
                        Ok(item) => Some(if event.kind == WireEventType::OutputItemAdded {
                            ResponseEvent::OutputItemAdded(item)
                        } else {
                            ResponseEvent::OutputItemDone(item)
                        }),
                        Err(cause) => {
                            tracing::debug!(%cause, "failed to parse Responses output item");
                            None
                        }
                    }),
                WireEventType::OutputTextDelta => {
                    event.delta.map(|delta| ResponseEvent::OutputTextDelta {
                        delta,
                        item_id: event.item_id,
                        content_index: event.content_index,
                    })
                }
                WireEventType::CustomToolCallInputDelta => event
                    .delta
                    .zip(event.item_id.or_else(|| event.call_id.clone()))
                    .map(|(delta, item_id)| ResponseEvent::ToolCallInputDelta {
                        item_id,
                        call_id: event.call_id,
                        delta,
                    }),
                WireEventType::ReasoningSummaryTextDelta => event
                    .delta
                    .zip(event.summary_index)
                    .map(
                        |(delta, summary_index)| ResponseEvent::ReasoningSummaryDelta {
                            delta,
                            summary_index,
                            item_id: event.item_id,
                        },
                    ),
                WireEventType::ReasoningSummaryTextDone => {
                    event.item_id.zip(event.text).zip(event.summary_index).map(
                        |((item_id, text), summary_index)| ResponseEvent::ReasoningSummaryDone {
                            item_id,
                            text,
                            summary_index,
                        },
                    )
                }
                WireEventType::ReasoningTextDelta => {
                    event
                        .delta
                        .zip(event.content_index)
                        .map(
                            |(delta, content_index)| ResponseEvent::ReasoningContentDelta {
                                delta,
                                content_index,
                                item_id: event.item_id,
                            },
                        )
                }
                WireEventType::ReasoningSummaryPartAdded => {
                    event.summary_index.map(|summary_index| {
                        ResponseEvent::ReasoningSummaryPartAdded {
                            summary_index,
                            item_id: event.item_id,
                        }
                    })
                }
                WireEventType::Completed => match event.response.map(decode_completion) {
                    Some(Ok(response)) => Some(ResponseEvent::Completed(response)),
                    Some(Err(cause)) => {
                        error = Some(ResponsesStreamError::Protocol(format!(
                            "failed to parse ResponseCompleted: {cause}"
                        )));
                        None
                    }
                    None => None,
                },
                WireEventType::Failed | WireEventType::Error => {
                    error = Some(upstream_failure(&serde_json::from_str::<Value>(data)?));
                    None
                }
                WireEventType::Incomplete => {
                    let reason = event
                        .response
                        .as_ref()
                        .and_then(|r| r.pointer("/incomplete_details/reason"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    error = Some(ResponsesStreamError::Protocol(format!(
                        "Incomplete response returned, reason: {reason}"
                    )));
                    None
                }
                WireEventType::FunctionCallArgumentsDelta => {
                    event.item_id.zip(event.delta).map(|(item_id, delta)| {
                        ResponseEvent::FunctionCallArgumentsDelta { item_id, delta }
                    })
                }
                WireEventType::FunctionCallArgumentsDone => {
                    event
                        .item_id
                        .zip(event.arguments)
                        .map(
                            |(item_id, arguments)| ResponseEvent::FunctionCallArgumentsDone {
                                item_id,
                                arguments,
                            },
                        )
                }
                WireEventType::CustomToolCallInputDone => event
                    .item_id
                    .or(event.call_id)
                    .zip(event.input)
                    .map(|(item_id, input)| ResponseEvent::ToolCallInputDone { item_id, input }),
                WireEventType::OutputTextDone => {
                    event.text.map(|text| ResponseEvent::OutputTextDone {
                        item_id: event.item_id,
                        content_index: event.content_index,
                        text,
                    })
                }
                WireEventType::RateLimits => {
                    rate_limits::parse_rate_limit_event(data).map(ResponseEvent::RateLimits)
                }
                WireEventType::Metadata
                | WireEventType::ReasoningSummaryPartDone
                | WireEventType::ContentPartAdded
                | WireEventType::ContentPartDone
                | WireEventType::InProgress
                | WireEventType::CodexMetadata
                | WireEventType::WebsocketTiming
                | WireEventType::NewToolEvent
                | WireEventType::RefusalDelta
                | WireEventType::McpCallArgumentsDelta
                | WireEventType::Other => None,
            };
        events.extend(semantic);
        Ok((events, error))
    }
}

fn header_events(headers: &HeaderMap) -> Vec<ResponseEvent> {
    let mut events = Vec::new();
    for (name, make) in [
        (
            "openai-model",
            ResponseEvent::ServerModel as fn(String) -> ResponseEvent,
        ),
        ("x-models-etag", ResponseEvent::ModelsEtag),
        ("x-request-id", ResponseEvent::RequestId),
        ("x-codex-turn-state", ResponseEvent::TurnState),
    ] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            events.push(make(value.to_owned()));
        }
    }
    events.extend(
        rate_limits::parse_all_rate_limits(headers)
            .into_iter()
            .map(ResponseEvent::RateLimits),
    );
    if headers.contains_key("x-reasoning-included") {
        events.push(ResponseEvent::ServerReasoningIncluded(true));
    }
    events
}

pub(crate) type ResponseStream =
    Pin<Box<dyn Stream<Item = Result<ResponseEvent, ResponsesStreamError>> + Send>>;

pub(crate) fn response_stream(
    response: Response,
    mut cancellation: Option<watch::Receiver<bool>>,
    idle_timeout: Duration,
) -> ResponseStream {
    let headers = header_events(response.headers());
    let mut decoder = EventDecoder {
        faster_model: response
            .headers()
            .get("x-codex-safety-buffering-faster-model")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        ..Default::default()
    };
    Box::pin(async_stream::stream! {
        for event in headers { yield Ok(event); }
        let mut stream = response.bytes_stream().eventsource();
        let mut response_error = None;
        loop {
            if cancellation.as_ref().is_some_and(|rx| *rx.borrow()) { yield Err(ResponsesStreamError::Cancelled); return }
            let poll = async {
                match timeout(idle_timeout, stream.next()).await {
                    Err(_) => Err(ResponsesStreamError::Timeout),
                    Ok(None) => Err(response_error.clone().unwrap_or(ResponsesStreamError::Closed)),
                    Ok(Some(Err(cause))) => Err(ResponsesStreamError::Sse(cause.to_string())),
                    Ok(Some(Ok(event))) => Ok(event.data),
                }
            };
            let result = match cancellation.as_mut() {
                Some(receiver) => tokio::select! { biased; _ = receiver.changed() => Err(ResponsesStreamError::Cancelled), result = poll => result },
                None => poll.await,
            };
            let data = match result { Ok(data) => data, Err(error) => { yield Err(error); return } };
            match decoder.decode(&data) {
                Ok((events, error)) => {
                    if let Some(error) = error { response_error = Some(error); }
                    for event in events {
                        let completed = matches!(event, ResponseEvent::Completed(_));
                        yield Ok(event);
                        if completed { return }
                    }
                }
                Err(cause) => tracing::debug!(%cause, payload_bytes = data.len(), "failed to parse Responses SSE event"),
            }
        }
    })
}

pub(crate) fn json_response_events(
    value: Value,
) -> Result<Vec<ResponseEvent>, ResponsesStreamError> {
    if value.get("error").is_some_and(|e| !e.is_null()) {
        return Err(upstream_failure(&json!({"response": value})));
    }
    if value.get("status").and_then(Value::as_str) == Some("incomplete") {
        return Err(ResponsesStreamError::Protocol(format!(
            "Incomplete response returned, reason: {}",
            value
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        )));
    }
    let mut events = Vec::new();
    if let Some(items) = value.get("output").and_then(Value::as_array) {
        for item in items {
            events.push(ResponseEvent::OutputItemDone(
                ResponseItem::from_value(item.clone())
                    .map_err(|e| ResponsesStreamError::InvalidPayload(e.to_string()))?,
            ));
        }
    }
    let completed = decode_completion(value).map_err(|e| {
        ResponsesStreamError::InvalidPayload(format!("invalid Responses JSON: {e}"))
    })?;
    events.push(ResponseEvent::Completed(completed));
    Ok(events)
}

fn decode_completion(value: Value) -> serde_json::Result<ResponseCompleted> {
    let usage = value.get("usage").filter(|value| !value.is_null()).cloned();
    let mut response: ResponseCompleted = serde_json::from_value(value)?;
    if let Some(usage) = usage {
        response.usage_metadata.get_or_insert_default().metadata = Some(usage);
    }
    Ok(response)
}
