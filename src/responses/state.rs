use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct OutputState {
    pub(crate) item: ResponseItem,
    pub(crate) done: bool,
    pub(crate) record_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ResponseState {
    pub(crate) response_id: Option<String>,
    pub(crate) output: Vec<OutputState>,
    pub(crate) completed: bool,
    pub(crate) error: Option<ResponsesStreamError>,
    pub(crate) server_model: Option<String>,
    pub(crate) model_verifications: Vec<ModelVerification>,
    pub(crate) moderation_metadata: Option<Value>,
    pub(crate) reasoning_included: bool,
    pub(crate) safety_buffering: Option<SafetyBuffering>,
    pub(crate) rate_limits: Vec<RateLimitSnapshot>,
    pub(crate) models_etag: Option<String>,
    pub(crate) turn_state: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) usage: Option<Usage>,
    pub(crate) usage_metadata: Option<UsageMetadata>,
    pub(crate) end_turn: Option<bool>,
    #[serde(skip)]
    extra: Extra,
    #[serde(skip)]
    pending: Vec<ResponseEvent>,
}

impl ResponseState {
    /// Returns newly completed items for the Thread's append-only history.
    pub(crate) fn apply(
        &mut self,
        event: &ResponseEvent,
    ) -> Result<Vec<usize>, ResponsesStreamError> {
        let mut completed = Vec::new();
        match event {
            ResponseEvent::Created { response_id } => self.response_id.clone_from(response_id),
            ResponseEvent::OutputItemAdded(item) => {
                self.remember(item.clone(), false)?;
            }
            ResponseEvent::OutputItemDone(item) => {
                let index = self.remember(item.clone(), true)?;
                if self.output[index].record_id.is_none() {
                    completed.push(index);
                }
            }
            ResponseEvent::Completed(response) => {
                self.response_id = Some(response.id.clone());
                self.usage.clone_from(&response.usage);
                self.usage_metadata.clone_from(&response.usage_metadata);
                self.end_turn = response.end_turn;
                self.extra.clone_from(&response.extra);
                if let Some(items) = response.extra.get("output").and_then(Value::as_array) {
                    for (output_index, item) in items.iter().enumerate() {
                        let item = ResponseItem::from_value(item.clone())
                            .map_err(|e| ResponsesStreamError::InvalidPayload(e.to_string()))?;
                        if item.id().is_some_and(|id| {
                            self.output
                                .iter()
                                .any(|v| v.done && v.item.id() == Some(id))
                        }) {
                            continue;
                        }
                        if item.id().is_none()
                            && self
                                .output
                                .get(output_index)
                                .is_some_and(|existing| existing.done && existing.item == item)
                        {
                            continue;
                        }
                        self.remember(item, true)?;
                    }
                }
                // COMPATIBILITY: OpenAI-LB responses may supply only deltas or
                // partial item.done payloads. Cybion owns this reconstruction;
                // remove when provider fixtures guarantee complete final items.
                if self.output.is_empty()
                    && self.pending.iter().any(|event| {
                        matches!(
                            event,
                            ResponseEvent::OutputTextDelta { .. }
                                | ResponseEvent::OutputTextDone { .. }
                        )
                    })
                {
                    self.remember(
                        ResponseItem::Message(Message {
                            id: None,
                            role: "assistant".to_owned(),
                            content: vec![],
                            phase: None,
                            extra: Extra::new(),
                        }),
                        false,
                    )?;
                }
                for (index, item) in self.output.iter_mut().enumerate() {
                    item.done = true;
                    if item.record_id.is_none() {
                        completed.push(index);
                    }
                }
                self.completed = true;
            }
            ResponseEvent::ServerModel(model) => self.server_model = Some(model.clone()),
            ResponseEvent::ModelVerifications(values) => {
                self.model_verifications.clone_from(values)
            }
            ResponseEvent::TurnModerationMetadata(value) => {
                self.moderation_metadata = Some(value.clone())
            }
            ResponseEvent::ServerReasoningIncluded(value) => self.reasoning_included = *value,
            ResponseEvent::SafetyBuffering(value) => self.safety_buffering = Some(value.clone()),
            ResponseEvent::RateLimits(value) => {
                if let Some(existing) = self
                    .rate_limits
                    .iter_mut()
                    .find(|v| v.limit_id == value.limit_id)
                {
                    *existing = value.clone();
                } else {
                    self.rate_limits.push(value.clone());
                }
            }
            ResponseEvent::ModelsEtag(value) => self.models_etag = Some(value.clone()),
            ResponseEvent::TurnState(value) => self.turn_state = Some(value.clone()),
            ResponseEvent::RequestId(value) => self.request_id = Some(value.clone()),
            ResponseEvent::OutputTextDelta { .. }
            | ResponseEvent::ToolCallInputDelta { .. }
            | ResponseEvent::ReasoningSummaryDelta { .. }
            | ResponseEvent::ReasoningSummaryDone { .. }
            | ResponseEvent::ReasoningContentDelta { .. }
            | ResponseEvent::ReasoningSummaryPartAdded { .. }
            | ResponseEvent::FunctionCallArgumentsDelta { .. }
            | ResponseEvent::FunctionCallArgumentsDone { .. }
            | ResponseEvent::ToolCallInputDone { .. }
            | ResponseEvent::OutputTextDone { .. } => {
                if let Some(item) = self
                    .output
                    .iter_mut()
                    .rev()
                    .find(|item| event_targets(event, &item.item))
                {
                    apply_update(&mut item.item, event)?;
                } else {
                    self.pending.push(event.clone());
                }
            }
        }
        Ok(completed)
    }

    fn remember(
        &mut self,
        mut item: ResponseItem,
        done: bool,
    ) -> Result<usize, ResponsesStreamError> {
        let index = item
            .id()
            .and_then(|id| self.output.iter().position(|v| v.item.id() == Some(id)))
            .or_else(|| {
                if item.id().is_none() {
                    self.output
                        .iter()
                        .rposition(|existing| !existing.done && existing.item.kind() == item.kind())
                } else {
                    None
                }
            });
        if let Some(index) = index {
            merge_partial_item(&self.output[index].item, &mut item);
        }
        let pending = std::mem::take(&mut self.pending);
        for event in pending {
            if event_targets(&event, &item) {
                apply_update(&mut item, &event)?;
            } else {
                self.pending.push(event);
            }
        }
        if let Some(index) = index {
            if !self.output[index].done {
                self.output[index].item = item;
                self.output[index].done = done;
            }
            Ok(index)
        } else {
            self.output.push(OutputState {
                item,
                done,
                record_id: None,
            });
            Ok(self.output.len() - 1)
        }
    }

    pub(crate) fn value(&self) -> Value {
        let mut value = json!(self.extra);
        value["id"] = json!(self.response_id);
        value["usage"] = json!(self.usage);
        value["usage_metadata"] = json!(self.usage_metadata);
        value["end_turn"] = json!(self.end_turn);
        value["output"] = json!(
            self.output
                .iter()
                .filter(|item| item.done)
                .map(|item| &item.item)
                .collect::<Vec<_>>()
        );
        value
    }
}

fn event_targets(event: &ResponseEvent, item: &ResponseItem) -> bool {
    let (target, kind) = match event {
        ResponseEvent::OutputTextDelta { item_id, .. }
        | ResponseEvent::OutputTextDone { item_id, .. } => (item_id.as_deref(), "message"),
        ResponseEvent::ReasoningSummaryDelta { item_id, .. }
        | ResponseEvent::ReasoningContentDelta { item_id, .. }
        | ResponseEvent::ReasoningSummaryPartAdded { item_id, .. } => {
            (item_id.as_deref(), "reasoning")
        }
        ResponseEvent::ReasoningSummaryDone { item_id, .. } => {
            (Some(item_id.as_str()), "reasoning")
        }
        ResponseEvent::ToolCallInputDelta { item_id, .. }
        | ResponseEvent::ToolCallInputDone { item_id, .. } => {
            (Some(item_id.as_str()), "custom_tool_call")
        }
        ResponseEvent::FunctionCallArgumentsDelta { item_id, .. }
        | ResponseEvent::FunctionCallArgumentsDone { item_id, .. } => {
            (Some(item_id.as_str()), "function_call")
        }
        _ => return false,
    };
    item.kind() == kind
        && target.is_none_or(|id| {
            item.id() == Some(id)
                || matches!(item, ResponseItem::CustomToolCall(call) if call.call_id == id)
        })
}

fn part_index(index: i64) -> Result<usize, ResponsesStreamError> {
    // Bound allocation from a remote index while retaining out-of-order parts.
    usize::try_from(index)
        .ok()
        .filter(|i| *i <= 4096)
        .ok_or_else(|| {
            ResponsesStreamError::Protocol(format!("invalid Responses part index: {index}"))
        })
}

fn summary_text(item: &mut Reasoning, index: i64) -> Result<&mut String, ResponsesStreamError> {
    let index = part_index(index)?;
    item.summary
        .resize_with(item.summary.len().max(index + 1), || {
            ReasoningSummary::SummaryText {
                text: String::new(),
                extra: Extra::new(),
            }
        });
    let ReasoningSummary::SummaryText { text, .. } = &mut item.summary[index];
    Ok(text)
}

fn message_text(item: &mut Message, index: i64) -> Result<&mut String, ResponsesStreamError> {
    let index = part_index(index)?;
    item.content
        .resize_with(item.content.len().max(index + 1), || {
            ContentItem::OutputText {
                text: String::new(),
                extra: Extra::new(),
            }
        });
    match &mut item.content[index] {
        ContentItem::OutputText { text, .. } => Ok(text),
        _ => Err(ResponsesStreamError::Protocol(
            "text delta targets non-text content".to_owned(),
        )),
    }
}

fn apply_update(
    item: &mut ResponseItem,
    event: &ResponseEvent,
) -> Result<(), ResponsesStreamError> {
    match (item, event) {
        (
            ResponseItem::Message(item),
            ResponseEvent::OutputTextDelta {
                delta,
                content_index,
                ..
            },
        ) => message_text(item, content_index.unwrap_or(0))?.push_str(delta),
        (
            ResponseItem::Message(item),
            ResponseEvent::OutputTextDone {
                text,
                content_index,
                ..
            },
        ) => *message_text(item, content_index.unwrap_or(0))? = text.clone(),
        (
            ResponseItem::Reasoning(item),
            ResponseEvent::ReasoningSummaryDelta {
                delta,
                summary_index,
                ..
            },
        ) => summary_text(item, *summary_index)?.push_str(delta),
        (
            ResponseItem::Reasoning(item),
            ResponseEvent::ReasoningSummaryDone {
                text,
                summary_index,
                ..
            },
        ) => *summary_text(item, *summary_index)? = text.clone(),
        (
            ResponseItem::Reasoning(item),
            ResponseEvent::ReasoningSummaryPartAdded { summary_index, .. },
        ) => {
            summary_text(item, *summary_index)?;
        }
        (
            ResponseItem::Reasoning(item),
            ResponseEvent::ReasoningContentDelta {
                delta,
                content_index,
                ..
            },
        ) => {
            let index = part_index(*content_index)?;
            let content = item.content.get_or_insert_default();
            content.resize_with(content.len().max(index + 1), || {
                ReasoningContent::ReasoningText {
                    text: String::new(),
                    extra: Extra::new(),
                }
            });
            match &mut content[index] {
                ReasoningContent::ReasoningText { text, .. }
                | ReasoningContent::Text { text, .. } => text.push_str(delta),
            }
        }
        (
            ResponseItem::FunctionCall(call),
            ResponseEvent::FunctionCallArgumentsDelta { delta, .. },
        ) => call.arguments.push_str(delta),
        (
            ResponseItem::FunctionCall(call),
            ResponseEvent::FunctionCallArgumentsDone { arguments, .. },
        ) => call.arguments.clone_from(arguments),
        (ResponseItem::CustomToolCall(call), ResponseEvent::ToolCallInputDelta { delta, .. }) => {
            call.input.push_str(delta)
        }
        (ResponseItem::CustomToolCall(call), ResponseEvent::ToolCallInputDone { input, .. }) => {
            call.input.clone_from(input)
        }
        _ => {}
    }
    Ok(())
}

fn merge_partial_item(existing: &ResponseItem, incoming: &mut ResponseItem) {
    // COMPATIBILITY: See ResponseState::apply. Non-empty final fields always win.
    match (existing, incoming) {
        (ResponseItem::Message(old), ResponseItem::Message(new)) if new.content.is_empty() => {
            new.content.clone_from(&old.content)
        }
        (ResponseItem::Reasoning(old), ResponseItem::Reasoning(new)) => {
            if new.summary.is_empty() {
                new.summary.clone_from(&old.summary);
            }
            if new.content.as_ref().is_none_or(Vec::is_empty) {
                new.content.clone_from(&old.content);
            }
        }
        (ResponseItem::FunctionCall(old), ResponseItem::FunctionCall(new))
            if new.arguments.is_empty() =>
        {
            new.arguments.clone_from(&old.arguments)
        }
        (ResponseItem::CustomToolCall(old), ResponseItem::CustomToolCall(new))
            if new.input.is_empty() =>
        {
            new.input.clone_from(&old.input)
        }
        _ => {}
    }
}
