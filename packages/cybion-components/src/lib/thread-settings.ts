import type { Thread, ThreadDefaults, ThreadPatch } from "../api"
import { MAX_BUDGET_USD_NANOS } from "./budget-stop"

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/// The literals a panel shows before `/api/thread-defaults` answers, so no field
/// is ever empty while the page is still loading.
export const FALLBACK_CONTEXT_BUDGET = 200000
export const FALLBACK_LOADED_MANUALS = 12

/**
 * The settings a Thread carries — the same names, in the same shape, that
 * `GET /api/thread-defaults` and a Thread row already use — so one form control
 * edits every surface that has them.
 *
 * A `null` on one of the seven nullable settings means "follow the account
 * default": that is exactly what a Thread row means by `null`, and it is what
 * the account defaults form never produces because it has nothing to follow.
 * `image_generation_model` and `audio_transcription_model` add one more state of
 * their own: the empty string turns that modality off.
 */
export type ThreadSettings = {
  model: string
  upstream_id: string | null
  reasoning_effort: ReasoningEffort
  service_tier_fast: boolean
  context_budget_tokens: number | null
  minimal_mode: boolean | null
  image_generation_model: string | null
  audio_transcription_model: string | null
  search_source: string | null
  max_loaded_manuals: number | null
  initial_manual_ids: string[] | null
  budget_usd_nanos: number | null
}

/// The seven settings a Thread inherits unless it names its own; each may be
/// omitted from a PATCH, `null` hands it back to the account default.
export type ThreadSettingsOverrides = Partial<Pick<ThreadSettings,
  "context_budget_tokens" | "minimal_mode" | "image_generation_model" |
  "audio_transcription_model" | "search_source" | "max_loaded_manuals" | "initial_manual_ids" |
  "budget_usd_nanos">>

const OVERRIDDEN = [
  "context_budget_tokens", "minimal_mode", "image_generation_model",
  "audio_transcription_model", "search_source", "max_loaded_manuals", "initial_manual_ids",
  "budget_usd_nanos",
] as const satisfies readonly (keyof ThreadSettings)[]

/** Every field of the schema, so a setting added later joins every reader below. */
export const THREAD_SETTINGS_FIELDS = [
  "model", "upstream_id", "reasoning_effort", "service_tier_fast", ...OVERRIDDEN,
] as const satisfies readonly (keyof ThreadSettings)[]

/** A Thread row as the value this form edits. */
export function threadSettingsFromThread(thread: Thread): ThreadSettings {
  return {
    model: thread.model,
    upstream_id: thread.upstream_id,
    reasoning_effort: thread.reasoning_effort,
    service_tier_fast: thread.service_tier_fast,
    context_budget_tokens: thread.context_budget_tokens,
    minimal_mode: thread.minimal_mode,
    image_generation_model: thread.image_generation_model,
    audio_transcription_model: thread.audio_transcription_model,
    search_source: thread.search_source,
    max_loaded_manuals: thread.max_loaded_manuals,
    initial_manual_ids: thread.initial_manual_ids,
    budget_usd_nanos: thread.budget_usd_nanos,
  }
}

/** The account defaults as the same value: nothing to follow, so nothing is null. */
export function threadSettingsFromDefaults(defaults: ThreadDefaults): ThreadSettings {
  return {
    model: defaults.model,
    upstream_id: defaults.upstream_id,
    reasoning_effort: defaults.reasoning_effort,
    service_tier_fast: defaults.service_tier_fast,
    context_budget_tokens: defaults.context_budget_tokens,
    minimal_mode: defaults.minimal_mode,
    image_generation_model: defaults.image_generation_model,
    audio_transcription_model: defaults.audio_transcription_model,
    search_source: defaults.search_source,
    max_loaded_manuals: defaults.max_loaded_manuals,
    initial_manual_ids: defaults.initial_manual_ids,
    budget_usd_nanos: defaults.budget_usd_nanos,
  }
}

function sameList(left: string[] | null, right: string[] | null) {
  if (left === right) return true
  if (left === null || right === null) return false
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * A Thread that does not exist yet: it starts from the model the account defaults
 * name and follows the other seven until the composer pins one. That is what the
 * first message has always sent, and it is why creation needs no writes of its own.
 */
export function threadSettingsForNewThread(defaults: ThreadSettings): ThreadSettings {
  return {
    model: defaults.model,
    upstream_id: defaults.upstream_id,
    reasoning_effort: defaults.reasoning_effort,
    service_tier_fast: defaults.service_tier_fast,
    context_budget_tokens: null,
    minimal_mode: null,
    image_generation_model: null,
    audio_transcription_model: null,
    search_source: null,
    max_loaded_manuals: null,
    initial_manual_ids: null,
    budget_usd_nanos: null,
  }
}

/** Whether two values hold the same settings, lists compared by content. */
export function sameThreadSettings(left: ThreadSettings, right: ThreadSettings) {
  return THREAD_SETTINGS_FIELDS.every((field) => field === "initial_manual_ids"
    ? sameList(left.initial_manual_ids, right.initial_manual_ids)
    : left[field] === right[field])
}

/**
 * The seven settings that differ, as a PATCH of that Thread — or of the account
 * defaults, whose PUT accepts the same names. Nothing that did not change is
 * sent, so a write carries one edit instead of the whole panel.
 */
export function threadSettingsOverrides(next: ThreadSettings, base: ThreadSettings): ThreadSettingsOverrides {
  const overrides: ThreadSettingsOverrides = {}
  for (const field of OVERRIDDEN) {
    if (field === "initial_manual_ids") {
      if (!sameList(next.initial_manual_ids, base.initial_manual_ids)) overrides.initial_manual_ids = next.initial_manual_ids
      continue
    }
    if (next[field] !== base[field]) Object.assign(overrides, { [field]: next[field] })
  }
  return overrides
}

/**
 * One Thread's PATCH for this edit, or `null` when the edit changed nothing.
 * A model and its upstream are one setting: changing either writes both, because
 * the controller refuses a model its upstream does not serve.
 */
export function threadSettingsPatch(next: ThreadSettings, base: ThreadSettings): ThreadPatch | null {
  const patch: ThreadPatch = threadSettingsOverrides(next, base)
  if (next.model !== base.model || next.upstream_id !== base.upstream_id) {
    patch.model = next.model
    patch.upstream_id = next.upstream_id
  }
  if (next.reasoning_effort !== base.reasoning_effort) patch.reasoning_effort = next.reasoning_effort
  if (next.service_tier_fast !== base.service_tier_fast) patch.service_tier_fast = next.service_tier_fast
  return Object.keys(patch).length === 0 ? null : patch
}

/**
 * The account-defaults payload for this value. The defaults form has nothing to
 * follow, so a setting the form holds empty keeps what the server already has:
 * clearing a box must not silently reset the account to zero.
 */
export function threadSettingsDefaults(next: ThreadSettings, saved: ThreadSettings): ThreadDefaults {
  return {
    model: next.model,
    upstream_id: next.upstream_id,
    reasoning_effort: next.reasoning_effort,
    service_tier_fast: next.service_tier_fast,
    context_budget_tokens: next.context_budget_tokens ?? saved.context_budget_tokens ?? FALLBACK_CONTEXT_BUDGET,
    minimal_mode: next.minimal_mode ?? saved.minimal_mode ?? false,
    image_generation_model: next.image_generation_model ?? saved.image_generation_model ?? "",
    audio_transcription_model: next.audio_transcription_model ?? saved.audio_transcription_model ?? null,
    search_source: next.search_source ?? saved.search_source ?? null,
    max_loaded_manuals: next.max_loaded_manuals ?? saved.max_loaded_manuals ?? FALLBACK_LOADED_MANUALS,
    initial_manual_ids: next.initial_manual_ids ?? saved.initial_manual_ids ?? [],
    budget_usd_nanos: next.budget_usd_nanos ?? saved.budget_usd_nanos ?? 0,
  }
}

/** The controller refuses an amount past its ceiling; the form may not offer one. */
export function budgetTooLarge(usdNanos: number | null) {
  return usdNanos !== null && usdNanos > MAX_BUDGET_USD_NANOS
}
