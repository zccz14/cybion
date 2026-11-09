//! Responses wire models. Field contracts follow openai/codex a592c38c16cd.
//! Extra fields survive history replay; known fields are always deserialized and validated.
use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

pub(crate) type Extra = BTreeMap<String, Value>;

macro_rules! response_items {
    ($($variant:ident($wire:literal) { $($(#[$attr:meta])* $field:ident: $ty:ty),* $(,)? }),* $(,)?) => {
        $(#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
        pub(crate) struct $variant {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub(crate) id: Option<String>,
            $($(#[$attr])* pub(crate) $field: $ty,)*
            #[serde(flatten)]
            pub(crate) extra: Extra,
        })*

        #[derive(Debug, Clone, PartialEq)]
        pub(crate) enum ResponseItem {
            $($variant($variant),)*
            Other { kind: String, fields: Extra },
        }

        impl ResponseItem {
            pub(crate) fn from_value(mut value: Value) -> serde_json::Result<Self> {
                let kind = value.as_object_mut().and_then(|object| object.remove("type"))
                    .and_then(|kind| kind.as_str().map(str::to_owned))
                    .ok_or_else(|| <serde_json::Error as serde::de::Error>::custom("response item requires string type"))?;
                match kind.as_str() {
                    $($wire => serde_json::from_value(value).map(Self::$variant),)*
                    "compaction_summary" => serde_json::from_value(value).map(Self::Compaction),
                    _ => Ok(Self::Other { kind, fields: serde_json::from_value(value)? }),
                }
            }

            pub(crate) fn kind(&self) -> &str {
                match self { $(Self::$variant(_) => $wire,)* Self::Other { kind, .. } => kind }
            }

            pub(crate) fn id(&self) -> Option<&str> {
                match self {
                    $(Self::$variant(item) => item.id.as_deref(),)*
                    Self::Other { fields, .. } => fields.get("id").and_then(Value::as_str),
                }
            }

            pub(crate) fn value(&self) -> Value {
                let mut value = match self {
                    $(Self::$variant(item) => json!(item),)*
                    Self::Other { fields, .. } => json!(fields),
                };
                value["type"] = json!(self.kind());
                value
            }
        }

        impl Serialize for ResponseItem {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.value().serialize(serializer)
            }
        }

        impl<'de> Deserialize<'de> for ResponseItem {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::from_value(Value::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

response_items! {
    AdditionalTools("additional_tools") { role: String, tools: Vec<Value> },
    Message("message") {
        role: String, content: Vec<ContentItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        phase: Option<MessagePhase>,
    },
    AgentMessage("agent_message") { author: String, recipient: String, content: Vec<AgentMessageContent> },
    Reasoning("reasoning") {
        summary: Vec<ReasoningSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ReasoningContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_content: Option<String>,
    },
    LocalShellCall("local_shell_call") { call_id: Option<String>, status: LocalShellStatus, action: LocalShellAction },
    FunctionCall("function_call") {
        name: String, call_id: String, arguments: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        encrypted_function_args: Option<Vec<String>>,
    },
    ToolSearchCall("tool_search_call") { call_id: Option<String>, status: Option<String>, execution: String, arguments: Value },
    FunctionCallOutput("function_call_output") {
        call_id: Option<String>, output: ToolOutput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
    },
    CustomToolCall("custom_tool_call") {
        call_id: String, name: String, input: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    CustomToolCallOutput("custom_tool_call_output") {
        call_id: String, output: ToolOutput,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    ToolSearchOutput("tool_search_output") { call_id: Option<String>, status: String, execution: String, tools: Vec<Value> },
    WebSearchCall("web_search_call") {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<WebSearchAction>
    },
    ImageGenerationCall("image_generation_call") {
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        revised_prompt: Option<String>,
        result: String
    },
    Compaction("compaction") { encrypted_content: String },
    ConfigurationUpdate("configuration_update") { reasoning: ConfigurationReasoning },
    CompactionTrigger("compaction_trigger") {},
    ContextCompaction("context_compaction") { encrypted_content: Option<String> },
}

impl ResponseItem {
    /// The provider's id for a tool call: the key that pairs a call with its output.
    /// Unlike [`ResponseItem::id`] it survives a provider renumbering item ids between
    /// the delta stream and the final snapshot.
    pub(crate) fn call_id(&self) -> Option<&str> {
        match self {
            Self::FunctionCall(item) => Some(&item.call_id),
            Self::CustomToolCall(item) => Some(&item.call_id),
            Self::LocalShellCall(item) => item.call_id.as_deref(),
            Self::FunctionCallOutput(item) => item.call_id.as_deref(),
            Self::CustomToolCallOutput(item) => Some(&item.call_id),
            Self::ToolSearchCall(item) => item.call_id.as_deref(),
            Self::ToolSearchOutput(item) => item.call_id.as_deref(),
            Self::Other { fields, .. } => fields.get("call_id").and_then(Value::as_str),
            _ => None,
        }
    }

    /// Whether both items are the same tool call: one call id, one request. Providers may
    /// renumber `id`, restate `status`, and reserialize `arguments` in the final snapshot,
    /// so none of those decide it.
    pub(crate) fn same_call(&self, other: &Self) -> bool {
        let Some(call_id) = self.call_id() else {
            return false;
        };
        self.kind() == other.kind()
            && other.call_id() == Some(call_id)
            && comparable_call(self) == comparable_call(other)
    }

    /// Moves the call to another id, keeping the request it was issued with.
    pub(crate) fn rename_call(&mut self, call_id: String) {
        match self {
            Self::FunctionCall(item) => item.call_id = call_id,
            Self::CustomToolCall(item) => item.call_id = call_id,
            Self::LocalShellCall(item) => item.call_id = Some(call_id),
            Self::FunctionCallOutput(item) => item.call_id = Some(call_id),
            Self::CustomToolCallOutput(item) => item.call_id = call_id,
            Self::ToolSearchCall(item) => item.call_id = Some(call_id),
            Self::ToolSearchOutput(item) => item.call_id = Some(call_id),
            Self::Other { fields, .. } => {
                fields.insert("call_id".to_owned(), Value::String(call_id));
            }
            _ => {}
        }
    }
}

/// [`ResponseItem::value`] with everything a provider may rewrite between the delta stream
/// and the final snapshot removed, and with JSON arguments compared as JSON, not as text.
fn comparable_call(item: &ResponseItem) -> Value {
    let mut value = item.value();
    if let Some(object) = value.as_object_mut() {
        object.remove("id");
        object.remove("status");
        for key in ["arguments", "input"] {
            let parsed = object
                .get(key)
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok());
            if let Some(parsed) = parsed {
                object.insert(key.to_owned(), parsed);
            }
        }
    }
    value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ContentItem {
    InputText {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
    OutputText {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
    InputImage {
        image_url: String,
        detail: Option<ImageDetail>,
        #[serde(flatten)]
        extra: Extra,
    },
    InputAudio {
        audio_url: String,
        #[serde(flatten)]
        extra: Extra,
    },
    EncryptedContent {
        encrypted_content: String,
        #[serde(flatten)]
        extra: Extra,
    },
    InputFile {
        file_id: Option<String>,
        file_data: Option<String>,
        file_url: Option<String>,
        filename: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
    Refusal {
        refusal: String,
        #[serde(flatten)]
        extra: Extra,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum AgentMessageContent {
    InputText {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
    EncryptedContent {
        encrypted_content: String,
        #[serde(flatten)]
        extra: Extra,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ImageDetail {
    Auto,
    Low,
    High,
    Original,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MessagePhase {
    Commentary,
    FinalAnswer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ReasoningSummary {
    SummaryText {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
}

impl ReasoningSummary {
    pub(crate) fn text(&self) -> &str {
        match self {
            Self::SummaryText { text, .. } => text,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ReasoningContent {
    ReasoningText {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
    Text {
        text: String,
        #[serde(flatten)]
        extra: Extra,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub(crate) enum ToolOutput {
    Text(String),
    Content(Vec<ContentItem>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LocalShellStatus {
    Completed,
    InProgress,
    Incomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum LocalShellAction {
    Exec {
        command: Vec<String>,
        timeout_ms: Option<u64>,
        working_directory: Option<String>,
        env: Option<BTreeMap<String, String>>,
        user: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum WebSearchAction {
    Search {
        query: Option<String>,
        queries: Option<Vec<String>>,
        #[serde(flatten)]
        extra: Extra,
    },
    OpenPage {
        url: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
    FindInPage {
        url: Option<String>,
        pattern: Option<String>,
        #[serde(flatten)]
        extra: Extra,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct ConfigurationReasoning {
    pub(crate) effort: ReasoningEffort,
    #[serde(flatten)]
    pub(crate) extra: Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub(crate) enum ReasoningEffort {
    Known(KnownReasoningEffort),
    Custom(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KnownReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
    Persistent,
}

impl ResponseItem {
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Message(message) => message
                .content
                .iter()
                .filter_map(|part| match part {
                    ContentItem::OutputText { text, .. } => Some(text.as_str()),
                    ContentItem::Refusal { refusal, .. } => Some(refusal.as_str()),
                    _ => None,
                })
                .collect(),
            Self::Reasoning(reasoning) => reasoning
                .summary
                .iter()
                .map(ReasoningSummary::text)
                .collect::<Vec<_>>()
                .join("\n\n"),
            _ => String::new(),
        }
    }
}
