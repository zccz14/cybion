use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct Usage {
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
    #[serde(default)]
    pub(crate) total_tokens: i64,
    pub(crate) input_tokens_details: Option<InputTokensDetails>,
    pub(crate) output_tokens_details: Option<OutputTokensDetails>,
    pub(crate) codex_rollout_budget_units: Option<serde_json::Number>,
    #[serde(flatten)]
    pub(crate) extra: super::items::Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct InputTokensDetails {
    #[serde(default)]
    pub(crate) cached_tokens: i64,
    #[serde(default)]
    pub(crate) cache_write_tokens: i64,
    #[serde(flatten)]
    pub(crate) extra: super::items::Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct OutputTokensDetails {
    #[serde(default)]
    pub(crate) reasoning_tokens: i64,
    #[serde(flatten)]
    pub(crate) extra: super::items::Extra,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct UsageMetadata {
    pub(crate) amount: Option<String>,
    pub(crate) metadata: Option<Value>,
    #[serde(flatten)]
    pub(crate) extra: super::items::Extra,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct SafetyBuffering {
    pub(crate) use_cases: Vec<String>,
    pub(crate) reasons: Vec<String>,
    #[serde(default)]
    pub(crate) show_buffering_ui: bool,
    #[serde(rename = "retry_model")]
    pub(crate) faster_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModelVerification {
    TrustedAccessForCyber,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct RateLimitSnapshot {
    pub(crate) limit_id: Option<String>,
    pub(crate) limit_name: Option<String>,
    pub(crate) normal_model_slug: Option<String>,
    pub(crate) primary: Option<RateLimitWindow>,
    pub(crate) secondary: Option<RateLimitWindow>,
    pub(crate) credits: Option<CreditsSnapshot>,
    pub(crate) individual_limit: Option<SpendControlLimitSnapshot>,
    pub(crate) spend_control_reached: Option<bool>,
    pub(crate) plan_type: Option<PlanType>,
    pub(crate) rate_limit_reached_type: Option<RateLimitReachedType>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct RateLimitWindow {
    pub(crate) used_percent: f64,
    pub(crate) window_minutes: Option<i64>,
    pub(crate) resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CreditsSnapshot {
    pub(crate) has_credits: bool,
    pub(crate) unlimited: bool,
    pub(crate) balance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct SpendControlLimitSnapshot {
    pub(crate) limit: String,
    pub(crate) used: String,
    pub(crate) remaining_percent: i32,
    pub(crate) resets_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RateLimitReachedType {
    RateLimitReached,
    WorkspaceOwnerCreditsDepleted,
    WorkspaceMemberCreditsDepleted,
    WorkspaceOwnerUsageLimitReached,
    WorkspaceMemberUsageLimitReached,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PlanType {
    Free,
    Go,
    Plus,
    Pro,
    ProLite,
    Team,
    #[serde(rename = "self_serve_business_prolite")]
    SelfServeBusinessProLite,
    #[serde(rename = "self_serve_business_usage_based")]
    SelfServeBusinessUsageBased,
    Business,
    Ent26,
    #[serde(rename = "enterprise_cbp_automation")]
    EnterpriseCbpAutomation,
    #[serde(rename = "enterprise_cbp_usage_based")]
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
    #[serde(rename = "edu_plus")]
    EduPlus,
    #[serde(rename = "edu_pro")]
    EduPro,
    #[serde(other)]
    Unknown,
}
