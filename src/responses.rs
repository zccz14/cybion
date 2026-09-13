use std::{
    collections::{HashMap, HashSet},
    fmt::Display,
};

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::Response;
use serde_json::{Value, json};
use tokio::{
    sync::watch,
    time::{Duration, timeout},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResponseItemKind {
    AdditionalTools,
    Message,
    AgentMessage,
    Reasoning,
    LocalShellCall,
    FunctionCall,
    ToolSearchCall,
    FunctionCallOutput,
    CustomToolCall,
    CustomToolCallOutput,
    ToolSearchOutput,
    WebSearchCall,
    ImageGenerationCall,
    Compaction,
    ConfigurationUpdate,
    CompactionTrigger,
    ContextCompaction,
    Other,
}

/// Lossless Responses output item enum. Each variant keeps the original wire
/// object so fields added by OpenAI remain available during history replay.
#[derive(Debug, Clone)]
pub(crate) enum ResponseItem {
    AdditionalTools(Value),
    Message(Value),
    AgentMessage(Value),
    Reasoning(Value),
    LocalShellCall(Value),
    FunctionCall(Value),
    ToolSearchCall(Value),
    FunctionCallOutput(Value),
    CustomToolCall(Value),
    CustomToolCallOutput(Value),
    ToolSearchOutput(Value),
    WebSearchCall(Value),
    ImageGenerationCall(Value),
    Compaction(Value),
    ConfigurationUpdate(Value),
    CompactionTrigger(Value),
    ContextCompaction(Value),
    Other(Value),
}

impl ResponseItem {
    pub(crate) fn from_value(value: Value) -> Self {
        match value.get("type").and_then(Value::as_str) {
            Some("additional_tools") => Self::AdditionalTools(value),
            Some("message") => Self::Message(value),
            Some("agent_message") => Self::AgentMessage(value),
            Some("reasoning") => Self::Reasoning(value),
            Some("local_shell_call") => Self::LocalShellCall(value),
            Some("function_call") => Self::FunctionCall(value),
            Some("tool_search_call") => Self::ToolSearchCall(value),
            Some("function_call_output") => Self::FunctionCallOutput(value),
            Some("custom_tool_call") => Self::CustomToolCall(value),
            Some("custom_tool_call_output") => Self::CustomToolCallOutput(value),
            Some("tool_search_output") => Self::ToolSearchOutput(value),
            Some("web_search_call") => Self::WebSearchCall(value),
            Some("image_generation_call") => Self::ImageGenerationCall(value),
            Some("compaction" | "compaction_summary") => Self::Compaction(value),
            Some("configuration_update") => Self::ConfigurationUpdate(value),
            Some("compaction_trigger") => Self::CompactionTrigger(value),
            Some("context_compaction") => Self::ContextCompaction(value),
            _ => Self::Other(value),
        }
    }

    pub(crate) fn kind(&self) -> ResponseItemKind {
        match self {
            Self::AdditionalTools(_) => ResponseItemKind::AdditionalTools,
            Self::Message(_) => ResponseItemKind::Message,
            Self::AgentMessage(_) => ResponseItemKind::AgentMessage,
            Self::Reasoning(_) => ResponseItemKind::Reasoning,
            Self::LocalShellCall(_) => ResponseItemKind::LocalShellCall,
            Self::FunctionCall(_) => ResponseItemKind::FunctionCall,
            Self::ToolSearchCall(_) => ResponseItemKind::ToolSearchCall,
            Self::FunctionCallOutput(_) => ResponseItemKind::FunctionCallOutput,
            Self::CustomToolCall(_) => ResponseItemKind::CustomToolCall,
            Self::CustomToolCallOutput(_) => ResponseItemKind::CustomToolCallOutput,
            Self::ToolSearchOutput(_) => ResponseItemKind::ToolSearchOutput,
            Self::WebSearchCall(_) => ResponseItemKind::WebSearchCall,
            Self::ImageGenerationCall(_) => ResponseItemKind::ImageGenerationCall,
            Self::Compaction(_) => ResponseItemKind::Compaction,
            Self::ConfigurationUpdate(_) => ResponseItemKind::ConfigurationUpdate,
            Self::CompactionTrigger(_) => ResponseItemKind::CompactionTrigger,
            Self::ContextCompaction(_) => ResponseItemKind::ContextCompaction,
            Self::Other(_) => ResponseItemKind::Other,
        }
    }

    pub(crate) fn value(&self) -> &Value {
        match self {
            Self::AdditionalTools(value)
            | Self::Message(value)
            | Self::AgentMessage(value)
            | Self::Reasoning(value)
            | Self::LocalShellCall(value)
            | Self::FunctionCall(value)
            | Self::ToolSearchCall(value)
            | Self::FunctionCallOutput(value)
            | Self::CustomToolCall(value)
            | Self::CustomToolCallOutput(value)
            | Self::ToolSearchOutput(value)
            | Self::WebSearchCall(value)
            | Self::ImageGenerationCall(value)
            | Self::Compaction(value)
            | Self::ConfigurationUpdate(value)
            | Self::CompactionTrigger(value)
            | Self::ContextCompaction(value)
            | Self::Other(value) => value,
        }
    }

    fn value_mut(&mut self) -> &mut Value {
        match self {
            Self::AdditionalTools(value)
            | Self::Message(value)
            | Self::AgentMessage(value)
            | Self::Reasoning(value)
            | Self::LocalShellCall(value)
            | Self::FunctionCall(value)
            | Self::ToolSearchCall(value)
            | Self::FunctionCallOutput(value)
            | Self::CustomToolCall(value)
            | Self::CustomToolCallOutput(value)
            | Self::ToolSearchOutput(value)
            | Self::WebSearchCall(value)
            | Self::ImageGenerationCall(value)
            | Self::Compaction(value)
            | Self::ConfigurationUpdate(value)
            | Self::CompactionTrigger(value)
            | Self::ContextCompaction(value)
            | Self::Other(value) => value,
        }
    }

    pub(crate) fn id(&self) -> Option<&str> {
        self.value().get("id").and_then(Value::as_str)
    }

    pub(crate) fn function_call(&self) -> Option<FunctionCall> {
        (self.kind() == ResponseItemKind::FunctionCall).then(|| {
            let value = self.value();
            let call_id = value
                .get("call_id")
                .or_else(|| value.get("id"))
                .and_then(Value::as_str)?
                .to_owned();
            let name = value.get("name").and_then(Value::as_str)?.to_owned();
            let arguments = value
                .get("arguments")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str(value).ok())
                .or_else(|| value.get("arguments").cloned())
                .unwrap_or_else(|| json!({}));
            Some(FunctionCall {
                call_id,
                name,
                arguments,
            })
        })?
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResponseEventKind {
    Created,
    OutputItemAdded,
    OutputItemDone,
    OutputTextDelta,
    OutputTextDone,
    CustomToolCallInputDelta,
    CustomToolCallInputDone,
    FunctionCallArgumentsDelta,
    FunctionCallArgumentsDone,
    McpCallArgumentsDelta,
    ReasoningSummaryPartAdded,
    ReasoningSummaryPartDone,
    ReasoningSummaryTextDelta,
    ReasoningSummaryTextDone,
    ReasoningTextDelta,
    ContentPartAdded,
    ContentPartDone,
    InProgress,
    Metadata,
    CodexMetadata,
    WebsocketTiming,
    NewToolEvent,
    RefusalDelta,
    Completed,
    Failed,
    Incomplete,
    Error,
    Unknown,
}

impl ResponseEventKind {
    fn from_wire(value: &str) -> Self {
        match value {
            "response.created" => Self::Created,
            "response.output_item.added" => Self::OutputItemAdded,
            "response.output_item.done" => Self::OutputItemDone,
            "response.output_text.delta" => Self::OutputTextDelta,
            "response.output_text.done" => Self::OutputTextDone,
            "response.custom_tool_call_input.delta" => Self::CustomToolCallInputDelta,
            "response.custom_tool_call_input.done" => Self::CustomToolCallInputDone,
            "response.function_call_arguments.delta" => Self::FunctionCallArgumentsDelta,
            "response.function_call_arguments.done" => Self::FunctionCallArgumentsDone,
            "response.mcp_call_arguments.delta" => Self::McpCallArgumentsDelta,
            "response.reasoning_summary_part.added" => Self::ReasoningSummaryPartAdded,
            "response.reasoning_summary_part.done" => Self::ReasoningSummaryPartDone,
            "response.reasoning_summary_text.delta" => Self::ReasoningSummaryTextDelta,
            "response.reasoning_summary_text.done" => Self::ReasoningSummaryTextDone,
            "response.reasoning_text.delta" => Self::ReasoningTextDelta,
            "response.content_part.added" => Self::ContentPartAdded,
            "response.content_part.done" => Self::ContentPartDone,
            "response.in_progress" => Self::InProgress,
            "response.metadata" => Self::Metadata,
            "codex.response.metadata" => Self::CodexMetadata,
            "responsesapi.websocket_timing" => Self::WebsocketTiming,
            "response.new_tool_event" => Self::NewToolEvent,
            "response.refusal.delta" => Self::RefusalDelta,
            "response.completed" => Self::Completed,
            "response.failed" => Self::Failed,
            "response.incomplete" => Self::Incomplete,
            "error" => Self::Error,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone)]
struct ResponsesStreamEvent {
    kind: ResponseEventKind,
    wire_type: String,
    value: Value,
}

impl ResponsesStreamEvent {
    fn parse(data: &str) -> Result<Self, ResponsesStreamError> {
        let value = serde_json::from_str::<Value>(data)
            .map_err(|error| ResponsesStreamError::InvalidPayload(format!("{error}: {data}")))?;
        let wire_type = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ResponsesStreamError::InvalidPayload("Responses event has no type".to_owned())
            })?
            .to_owned();
        let kind = ResponseEventKind::from_wire(&wire_type);
        Ok(Self {
            kind,
            wire_type,
            value,
        })
    }

    fn item(&self) -> Option<ResponseItem> {
        self.value
            .get("item")
            .cloned()
            .map(ResponseItem::from_value)
    }

    fn response(&self) -> Option<Value> {
        self.value.get("response").cloned()
    }

    fn string(&self, name: &str) -> Option<&str> {
        self.value.get(name).and_then(Value::as_str)
    }

    fn item_id(&self) -> Option<&str> {
        self.string("item_id").or_else(|| self.string("call_id"))
    }

    fn summary_index(&self) -> Option<usize> {
        self.value
            .get("summary_index")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
    }

    fn content_index(&self) -> usize {
        self.value
            .get("content_index")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FunctionCall {
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug)]
pub(crate) enum ResponsesStreamError {
    Cancelled,
    Timeout,
    Closed,
    Sse(String),
    InvalidPayload(String),
    ContextOverflow(String),
    Protocol(String),
}

impl Display for ResponsesStreamError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => formatter.write_str("request superseded by a newer input"),
            Self::Timeout => formatter.write_str("idle timeout waiting for SSE"),
            Self::Closed => formatter.write_str("stream closed before response.completed"),
            Self::Sse(error) => write!(formatter, "SSE stream error: {error}"),
            Self::InvalidPayload(error) => {
                write!(formatter, "invalid Responses SSE payload: {error}")
            }
            Self::ContextOverflow(error) => formatter.write_str(error),
            Self::Protocol(error) => formatter.write_str(error),
        }
    }
}

#[derive(Debug)]
pub(crate) struct StreamedResponse {
    pub(crate) value: Value,
    pub(crate) output_items: Vec<ResponseItem>,
}

#[derive(Default)]
struct ResponseAccumulator {
    output: Vec<ResponseItem>,
    output_indices: HashMap<String, usize>,
    completed_output_indices: HashSet<usize>,
    pending_arguments: HashMap<String, String>,
    pending_custom_input: HashMap<String, String>,
    pending_output_text: HashMap<(String, usize), String>,
    pending_reasoning_text: HashMap<(String, usize), String>,
    saw_done: bool,
}

impl ResponseAccumulator {
    fn apply(
        &mut self,
        event: ResponsesStreamEvent,
    ) -> Result<Option<StreamedResponse>, ResponsesStreamError> {
        match event.kind {
            ResponseEventKind::OutputItemAdded => {
                if let Some(item) = event.item() {
                    self.remember(item);
                }
            }
            ResponseEventKind::OutputItemDone => {
                if let Some(mut item) = event.item() {
                    self.apply_pending(&mut item);
                    let index = self.remember(item);
                    self.completed_output_indices.insert(index);
                }
            }
            ResponseEventKind::FunctionCallArgumentsDelta => {
                if let (Some(item_id), Some(delta)) = (event.item_id(), event.string("delta")) {
                    self.append_string(item_id, "arguments", delta, true);
                }
            }
            ResponseEventKind::FunctionCallArgumentsDone => {
                if let (Some(item_id), Some(arguments)) =
                    (event.item_id(), event.string("arguments"))
                {
                    self.set_string(item_id, "arguments", arguments, true);
                }
            }
            ResponseEventKind::CustomToolCallInputDelta => {
                if let (Some(item_id), Some(delta)) = (event.item_id(), event.string("delta")) {
                    self.append_string(item_id, "input", delta, false);
                }
            }
            ResponseEventKind::CustomToolCallInputDone => {
                if let (Some(item_id), Some(input)) = (event.item_id(), event.string("input")) {
                    self.set_string(item_id, "input", input, false);
                }
            }
            ResponseEventKind::OutputTextDelta => {
                if let Some(delta) = event.string("delta") {
                    self.append_content(event.item_id(), event.content_index(), delta, false);
                }
            }
            ResponseEventKind::ReasoningTextDelta => {
                if let Some(delta) = event.string("delta") {
                    self.append_content(event.item_id(), event.content_index(), delta, true);
                }
            }
            ResponseEventKind::ReasoningSummaryPartAdded => {
                if let (Some(item_id), Some(summary_index), Some(part)) = (
                    event.item_id(),
                    event.summary_index(),
                    event.value.get("part").cloned(),
                ) {
                    self.set_summary_part(item_id, summary_index, part);
                }
            }
            ResponseEventKind::ReasoningSummaryTextDelta => {
                if let (Some(item_id), Some(summary_index), Some(delta)) = (
                    event.item_id(),
                    event.summary_index(),
                    event.string("delta"),
                ) {
                    self.append_summary_text(item_id, summary_index, delta);
                }
            }
            ResponseEventKind::ReasoningSummaryTextDone => {
                if let (Some(item_id), Some(summary_index), Some(text)) =
                    (event.item_id(), event.summary_index(), event.string("text"))
                {
                    self.set_summary_text(item_id, summary_index, text);
                }
            }
            ResponseEventKind::Completed => {
                let response = event.response().ok_or_else(|| {
                    ResponsesStreamError::Protocol(
                        "Responses completion has no response".to_owned(),
                    )
                })?;
                return Ok(Some(self.finish(response)));
            }
            ResponseEventKind::Incomplete => {
                let response = event.response().ok_or_else(|| {
                    ResponsesStreamError::Protocol("incomplete response has no response".to_owned())
                })?;
                let reason = response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                if matches!(
                    reason,
                    "context_length_exceeded" | "context_window_exceeded"
                ) {
                    return Err(ResponsesStreamError::ContextOverflow(format!(
                        "upstream Responses stream exceeded the context window: {reason}"
                    )));
                }
                return Err(ResponsesStreamError::Protocol(format!(
                    "Incomplete response returned, reason: {reason}"
                )));
            }
            ResponseEventKind::Failed | ResponseEventKind::Error => {
                let detail = upstream_error_detail(&event.value);
                if is_context_overflow_value(&event.value) {
                    return Err(ResponsesStreamError::ContextOverflow(format!(
                        "upstream Responses stream exceeded the context window: {detail}"
                    )));
                }
                return Err(ResponsesStreamError::Protocol(format!(
                    "upstream {}: {}",
                    event.wire_type, detail
                )));
            }
            ResponseEventKind::Created
            | ResponseEventKind::OutputTextDone
            | ResponseEventKind::ReasoningSummaryPartDone
            | ResponseEventKind::ContentPartAdded
            | ResponseEventKind::ContentPartDone
            | ResponseEventKind::InProgress
            | ResponseEventKind::Metadata
            | ResponseEventKind::CodexMetadata
            | ResponseEventKind::WebsocketTiming
            | ResponseEventKind::NewToolEvent
            | ResponseEventKind::RefusalDelta
            | ResponseEventKind::McpCallArgumentsDelta
            | ResponseEventKind::Unknown => {
                tracing::trace!(event_type = %event.wire_type, "unhandled Responses event");
            }
        }
        Ok(None)
    }

    fn finish(&mut self, mut response: Value) -> StreamedResponse {
        let mut output = if !self.completed_output_indices.is_empty() {
            std::mem::take(&mut self.output)
                .into_iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    self.completed_output_indices
                        .contains(&index)
                        .then_some(item)
                })
                .collect::<Vec<_>>()
        } else {
            std::mem::take(&mut self.output)
        };
        if output.is_empty()
            && let Some(existing) = response.get("output").and_then(Value::as_array)
        {
            output = existing
                .iter()
                .cloned()
                .map(ResponseItem::from_value)
                .collect();
        }
        self.append_orphan_output_text(&mut output);
        let output_values = output.iter().map(ResponseItem::value).cloned().collect();
        response["output"] = Value::Array(output_values);
        StreamedResponse {
            value: response,
            output_items: output,
        }
    }

    fn append_orphan_output_text(&mut self, output: &mut Vec<ResponseItem>) {
        let mut pending = self
            .pending_output_text
            .iter()
            .filter(|((item_id, _), _)| item_id.is_empty())
            .map(|((_, index), text)| (*index, text.clone()))
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return;
        }
        pending.sort_by_key(|(index, _)| *index);
        let text = pending
            .iter()
            .map(|(_, text)| text.as_str())
            .collect::<String>();
        let has_message = output
            .iter()
            .any(|item| item.kind() == ResponseItemKind::Message);
        if !has_message {
            output.push(ResponseItem::from_value(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            })));
        }
        self.pending_output_text
            .retain(|(item_id, _), _| !item_id.is_empty());
    }

    fn remember(&mut self, mut item: ResponseItem) -> usize {
        self.apply_pending(&mut item);
        let Some(item_id) = item.id().map(str::to_owned) else {
            self.output.push(item);
            return self.output.len() - 1;
        };
        if let Some(index) = self.output_indices.get(&item_id).copied() {
            let existing = self.output[index].value().clone();
            let incoming = item.value_mut();
            merge_item_values(&existing, incoming);
            self.output[index] = ResponseItem::from_value(incoming.clone());
            return index;
        }
        let index = self.output.len();
        self.output.push(item);
        self.output_indices.insert(item_id, index);
        index
    }

    fn apply_pending(&mut self, item: &mut ResponseItem) {
        let Some(item_id) = item.id().map(str::to_owned) else {
            return;
        };
        if let Some(arguments) = self.pending_arguments.remove(&item_id) {
            append_value_string(item.value_mut(), "arguments", &arguments);
        }
        if let Some(input) = self.pending_custom_input.remove(&item_id) {
            append_value_string(item.value_mut(), "input", &input);
        }
        let output_keys = self
            .pending_output_text
            .keys()
            .filter(|(pending_id, _)| pending_id == &item_id)
            .cloned()
            .collect::<Vec<_>>();
        for (_, content_index) in output_keys {
            if let Some(text) = self
                .pending_output_text
                .remove(&(item_id.clone(), content_index))
            {
                append_content_to_value(item.value_mut(), content_index, &text, false);
            }
        }
        let reasoning_keys = self
            .pending_reasoning_text
            .keys()
            .filter(|(pending_id, _)| pending_id == &item_id)
            .cloned()
            .collect::<Vec<_>>();
        for (_, content_index) in reasoning_keys {
            if let Some(text) = self
                .pending_reasoning_text
                .remove(&(item_id.clone(), content_index))
            {
                append_content_to_value(item.value_mut(), content_index, &text, true);
            }
        }
    }

    fn append_string(&mut self, item_id: &str, field: &str, delta: &str, arguments: bool) {
        if let Some(index) = self.output_indices.get(item_id).copied() {
            append_value_string(self.output[index].value_mut(), field, delta);
        } else {
            let target = if arguments {
                &mut self.pending_arguments
            } else {
                &mut self.pending_custom_input
            };
            target
                .entry(item_id.to_owned())
                .or_default()
                .push_str(delta);
        }
    }

    fn set_string(&mut self, item_id: &str, field: &str, value: &str, arguments: bool) {
        if let Some(index) = self.output_indices.get(item_id).copied() {
            self.output[index].value_mut()[field] = Value::String(value.to_owned());
        } else {
            let target = if arguments {
                &mut self.pending_arguments
            } else {
                &mut self.pending_custom_input
            };
            target.insert(item_id.to_owned(), value.to_owned());
        }
    }

    fn append_content(
        &mut self,
        item_id: Option<&str>,
        content_index: usize,
        delta: &str,
        reasoning: bool,
    ) {
        let Some(item_id) = item_id else {
            let target = if reasoning {
                &mut self.pending_reasoning_text
            } else {
                &mut self.pending_output_text
            };
            target
                .entry((String::new(), content_index))
                .or_default()
                .push_str(delta);
            return;
        };
        if let Some(index) = self.output_indices.get(item_id).copied() {
            append_content_to_value(
                self.output[index].value_mut(),
                content_index,
                delta,
                reasoning,
            );
        } else {
            let target = if reasoning {
                &mut self.pending_reasoning_text
            } else {
                &mut self.pending_output_text
            };
            target
                .entry((item_id.to_owned(), content_index))
                .or_default()
                .push_str(delta);
        }
    }

    fn set_summary_part(&mut self, item_id: &str, summary_index: usize, part: Value) {
        if let Some(index) = self.output_indices.get(item_id).copied() {
            set_summary_part_value(self.output[index].value_mut(), summary_index, part);
        }
    }

    fn append_summary_text(&mut self, item_id: &str, summary_index: usize, delta: &str) {
        if let Some(index) = self.output_indices.get(item_id).copied() {
            let item = self.output[index].value_mut();
            let current = item
                .pointer(&format!("/summary/{summary_index}/text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            set_summary_text_value(item, summary_index, &format!("{current}{delta}"));
        }
    }

    fn set_summary_text(&mut self, item_id: &str, summary_index: usize, text: &str) {
        if let Some(index) = self.output_indices.get(item_id).copied() {
            set_summary_text_value(self.output[index].value_mut(), summary_index, text);
        }
    }
}

fn merge_item_values(existing: &Value, incoming: &mut Value) {
    for field in ["arguments", "input", "summary", "content"] {
        let should_copy = match incoming.get(field) {
            None => true,
            Some(Value::String(value)) => value.is_empty(),
            Some(Value::Array(value)) => value.is_empty(),
            Some(_) => false,
        };
        if should_copy && let Some(value) = existing.get(field) {
            incoming[field] = value.clone();
        }
    }
}

fn append_value_string(item: &mut Value, field: &str, delta: &str) {
    let current = item
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    item[field] = Value::String(format!("{current}{delta}"));
}

fn append_content_to_value(item: &mut Value, content_index: usize, delta: &str, reasoning: bool) {
    let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) else {
        item["content"] = Value::Array(Vec::new());
        return append_content_to_value(item, content_index, delta, reasoning);
    };
    while content.len() <= content_index {
        content.push(json!({
            "type": if reasoning { "reasoning_text" } else { "output_text" },
            "text": ""
        }));
    }
    let entry = &mut content[content_index];
    let current = entry
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    entry["text"] = Value::String(format!("{current}{delta}"));
}

fn set_summary_part_value(item: &mut Value, summary_index: usize, part: Value) {
    let Some(summary) = item.get_mut("summary").and_then(Value::as_array_mut) else {
        item["summary"] = Value::Array(Vec::new());
        return set_summary_part_value(item, summary_index, part);
    };
    while summary.len() <= summary_index {
        summary.push(json!({"type":"summary_text","text":""}));
    }
    summary[summary_index] = part;
}

fn set_summary_text_value(item: &mut Value, summary_index: usize, text: &str) {
    let Some(summary) = item.get_mut("summary").and_then(Value::as_array_mut) else {
        item["summary"] = Value::Array(Vec::new());
        return set_summary_text_value(item, summary_index, text);
    };
    while summary.len() <= summary_index {
        summary.push(json!({"type":"summary_text","text":""}));
    }
    summary[summary_index]["type"] = json!("summary_text");
    summary[summary_index]["text"] = json!(text);
}

fn upstream_error_detail(value: &Value) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.pointer("/response/error/message"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .unwrap_or("upstream Responses error")
        .to_owned()
}

fn is_context_overflow_value(value: &Value) -> bool {
    matches!(
        value
            .pointer("/error/code")
            .or_else(|| value.pointer("/response/error/code"))
            .or_else(|| value.pointer("/response/incomplete_details/reason"))
            .or_else(|| value.get("code"))
            .and_then(Value::as_str),
        Some("context_length_exceeded" | "context_window_exceeded")
    )
}

enum StreamPoll {
    Data(String),
    Error(String),
    Closed,
    Timeout,
    Cancelled,
}

pub(crate) async fn read_response_stream(
    response: Response,
    cancellation: &mut Option<watch::Receiver<bool>>,
    idle_timeout: Duration,
) -> Result<StreamedResponse, ResponsesStreamError> {
    let mut stream = response.bytes_stream().eventsource();
    let mut accumulator = ResponseAccumulator::default();
    loop {
        if cancellation
            .as_ref()
            .is_some_and(|receiver| *receiver.borrow())
        {
            return Err(ResponsesStreamError::Cancelled);
        }
        let poll = match cancellation.as_mut() {
            Some(receiver) => tokio::select! {
                biased;
                _ = receiver.changed() => StreamPoll::Cancelled,
                result = timeout(idle_timeout, stream.next()) => match result {
                    Err(_) => StreamPoll::Timeout,
                    Ok(None) => StreamPoll::Closed,
                    Ok(Some(Err(error))) => StreamPoll::Error(error.to_string()),
                    Ok(Some(Ok(event))) => StreamPoll::Data(event.data),
                },
            },
            None => match timeout(idle_timeout, stream.next()).await {
                Err(_) => StreamPoll::Timeout,
                Ok(None) => StreamPoll::Closed,
                Ok(Some(Err(error))) => StreamPoll::Error(error.to_string()),
                Ok(Some(Ok(event))) => StreamPoll::Data(event.data),
            },
        };
        match poll {
            StreamPoll::Cancelled => return Err(ResponsesStreamError::Cancelled),
            StreamPoll::Timeout => return Err(ResponsesStreamError::Timeout),
            StreamPoll::Closed => {
                return if accumulator.saw_done {
                    Err(ResponsesStreamError::Protocol(
                        "upstream stream sent [DONE] without a Responses completion event"
                            .to_owned(),
                    ))
                } else {
                    Err(ResponsesStreamError::Closed)
                };
            }
            StreamPoll::Error(error) => return Err(ResponsesStreamError::Sse(error)),
            StreamPoll::Data(data) => {
                if data.trim().is_empty() {
                    continue;
                }
                if data.trim() == "[DONE]" {
                    accumulator.saw_done = true;
                    continue;
                }
                let event = match ResponsesStreamEvent::parse(&data) {
                    Ok(event) => event,
                    Err(ResponsesStreamError::InvalidPayload(error)) => {
                        tracing::debug!(%error, "failed to parse Responses SSE event");
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                if let Some(response) = accumulator.apply(event)? {
                    return Ok(response);
                }
            }
        }
    }
}

pub(crate) fn parse_json_response(value: Value) -> StreamedResponse {
    let output_items = value
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .cloned()
                .map(ResponseItem::from_value)
                .collect()
        })
        .unwrap_or_default();
    StreamedResponse {
        value,
        output_items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_item_variants_preserve_wire_payloads() {
        let item = ResponseItem::from_value(json!({
            "id":"fc_1",
            "type":"function_call",
            "call_id":"call_1",
            "name":"bash",
            "arguments":"{\"worker_id\":\"worker-1\"}",
            "future_field":true
        }));
        assert_eq!(item.kind(), ResponseItemKind::FunctionCall);
        let call = item.function_call().unwrap();
        assert_eq!(call.call_id, "call_1");
        assert_eq!(call.arguments["worker_id"], "worker-1");
        assert_eq!(item.value()["future_field"], true);
    }

    #[test]
    fn accumulator_reassembles_function_call_deltas() {
        let mut accumulator = ResponseAccumulator::default();
        for data in [
            r#"{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","arguments":"","call_id":"call_1","name":"bash"}}"#,
            r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"worker_id\":\"worker-1\"}"}"#,
            r#"{"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","arguments":"","call_id":"call_1","name":"bash"}}"#,
        ] {
            accumulator
                .apply(ResponsesStreamEvent::parse(data).unwrap())
                .unwrap();
        }
        let response = accumulator
            .apply(
                ResponsesStreamEvent::parse(
                    r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
                )
                .unwrap(),
            )
            .unwrap()
            .unwrap();
        let call = response.output_items[0].function_call().unwrap();
        assert_eq!(call.arguments["worker_id"], "worker-1");
    }

    #[test]
    fn accumulator_reassembles_output_and_reasoning_deltas() {
        let mut accumulator = ResponseAccumulator::default();
        for data in [
            r#"{"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}"#,
            r#"{"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","summary":[]}}"#,
            r#"{"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"hello"}"#,
            r#"{"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":" world"}"#,
            r#"{"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0,"part":{"type":"summary_text","text":""}}"#,
            r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"checking"}"#,
            r#"{"type":"response.reasoning_summary_text.done","item_id":"rs_1","summary_index":0,"text":"checking"}"#,
            r#"{"type":"response.output_item.done","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}"#,
            r#"{"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","summary":[]}}"#,
        ] {
            accumulator
                .apply(ResponsesStreamEvent::parse(data).unwrap())
                .unwrap();
        }
        let response = accumulator
            .apply(
                ResponsesStreamEvent::parse(
                    r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
                )
                .unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            response.value["output"][0]["content"][0]["text"],
            "hello world"
        );
        assert_eq!(
            response.value["output"][1]["summary"][0]["text"],
            "checking"
        );
    }

    #[test]
    fn incomplete_responses_are_errors_like_codex() {
        let mut accumulator = ResponseAccumulator::default();
        let event = ResponsesStreamEvent::parse(
            r#"{"type":"response.incomplete","response":{"id":"resp_1","incomplete_details":{"reason":"max_output_tokens"}}}"#,
        )
        .unwrap();
        let error = accumulator.apply(event).unwrap_err();
        assert!(
            matches!(error, ResponsesStreamError::Protocol(message) if message.contains("max_output_tokens"))
        );
    }
}
