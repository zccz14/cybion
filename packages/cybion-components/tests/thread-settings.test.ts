import { describe, expect, it } from "vitest"

import type { Thread, ThreadDefaults } from "../src/api"
import {
  THREAD_SETTINGS_FIELDS, budgetTooLarge, sameThreadSettings, threadSettingsDefaults,
  threadSettingsForNewThread, threadSettingsFromDefaults, threadSettingsFromThread,
  threadSettingsOverrides, threadSettingsPatch, type ThreadSettings,
} from "../src/lib/thread-settings"

const defaults: ThreadDefaults = {
  search_source: null,
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "gpt-image-2",
  audio_transcription_model: "whisper-1", max_loaded_manuals: 12, initial_manual_ids: ["manual-a"],
  budget_usd_nanos: 10_000_000_000,
}

const thread: Thread = {
  search_source: null,
  id: "thread-a", title: "Fixture", status: "idle", display_status: "ready", running_summary: null,
  created_by: "web", external_ref: null, model: "gpt-6-astra", upstream_id: "up-deepseek",
  reasoning_effort: "high", service_tier_fast: true, context_budget_tokens: null, minimal_mode: null,
  image_generation_model: null, audio_transcription_model: "gpt-4o-transcribe", max_loaded_manuals: 20,
  budget_usd_nanos: 500_000_000, initial_manual_ids: null, archived_at: null, context_tokens: null,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_hit_rate: null, cost_usd_nanos: 0, cost_settled_requests: 0 },
  created_at: 1, updated_at: 1,
}

describe("the settings schema", () => {
  it("reads a Thread row and the account defaults as the same value", () => {
    expect(threadSettingsFromDefaults(defaults)).toEqual({
      model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
      context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "gpt-image-2",
      audio_transcription_model: "whisper-1", search_source: null, max_loaded_manuals: 12, initial_manual_ids: ["manual-a"],
      budget_usd_nanos: 10_000_000_000,
    })
    // A Thread keeps its nulls: each one means "follow the account default".
    expect(threadSettingsFromThread(thread)).toEqual({
      model: "gpt-6-astra", upstream_id: "up-deepseek", reasoning_effort: "high", service_tier_fast: true,
      context_budget_tokens: null, minimal_mode: null, image_generation_model: null,
      audio_transcription_model: "gpt-4o-transcribe", search_source: null, max_loaded_manuals: 20,
      budget_usd_nanos: 500_000_000, initial_manual_ids: null,
    })
  })

  it("lists every field once, so a reader that walks the list cannot skip one", () => {
    expect([...THREAD_SETTINGS_FIELDS]).toEqual([
      "model", "upstream_id", "reasoning_effort", "service_tier_fast", "context_budget_tokens",
      "minimal_mode", "image_generation_model", "audio_transcription_model", "search_source", "max_loaded_manuals",
      "initial_manual_ids", "budget_usd_nanos",
    ])
  })

  it("starts a new Thread from the default model and follows the account for the rest", () => {
    const created = threadSettingsForNewThread(threadSettingsFromDefaults(defaults))
    expect(created).toEqual({
      model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
      context_budget_tokens: null, minimal_mode: null, image_generation_model: null,
      audio_transcription_model: null, search_source: null, max_loaded_manuals: null, initial_manual_ids: null, budget_usd_nanos: null,
    })
  })

  it("compares manual lists by content instead of by identity", () => {
    const left = threadSettingsFromDefaults(defaults)
    expect(sameThreadSettings(left, { ...left, initial_manual_ids: ["manual-a"] })).toBe(true)
    expect(sameThreadSettings(left, { ...left, initial_manual_ids: [] })).toBe(false)
    expect(sameThreadSettings(left, { ...left })).toBe(true)
    expect(sameThreadSettings(left, { ...left, minimal_mode: true })).toBe(false)
  })
})

describe("the writers", () => {
  const saved = threadSettingsFromThread(thread)

  it("sends nothing when an edit changed nothing", () => {
    expect(threadSettingsPatch(saved, saved)).toBeNull()
    expect(threadSettingsOverrides(saved, saved)).toEqual({})
  })

  it("sends only the settings that differ", () => {
    expect(threadSettingsPatch({ ...saved, budget_usd_nanos: 50_000_000 }, saved)).toEqual({ budget_usd_nanos: 50_000_000 })
    expect(threadSettingsPatch({ ...saved, context_budget_tokens: 150000 }, saved)).toEqual({ context_budget_tokens: 150000 })
    // Clearing an override is a value of its own: null hands it back to the default.
    expect(threadSettingsPatch({ ...saved, max_loaded_manuals: null }, saved)).toEqual({ max_loaded_manuals: null })
    expect(threadSettingsPatch({ ...saved, initial_manual_ids: ["manual-b"] }, saved)).toEqual({ initial_manual_ids: ["manual-b"] })
  })

  it("writes a model together with its upstream, because either one alone is refused", () => {
    expect(threadSettingsPatch({ ...saved, model: "deepseek-flash" }, saved)).toEqual({ model: "deepseek-flash", upstream_id: "up-deepseek" })
    expect(threadSettingsPatch({ ...saved, upstream_id: "up-lb" }, saved)).toEqual({ model: "gpt-6-astra", upstream_id: "up-lb" })
    expect(threadSettingsPatch({ ...saved, reasoning_effort: "max", service_tier_fast: false }, saved)).toEqual({ reasoning_effort: "max", service_tier_fast: false })
  })

  it("keeps the saved default when the form holds an empty box", () => {
    const savedDefaults = threadSettingsFromDefaults(defaults)
    // The defaults form has nothing to follow, so an empty box must not reset the
    // account: the payload carries what the server already holds.
    expect(threadSettingsDefaults({ ...savedDefaults, context_budget_tokens: null, budget_usd_nanos: null }, savedDefaults)).toEqual(defaults)
    expect(threadSettingsDefaults({ ...savedDefaults, budget_usd_nanos: 0 }, savedDefaults).budget_usd_nanos).toBe(0)
    expect(threadSettingsDefaults({ ...savedDefaults, image_generation_model: "" }, savedDefaults).image_generation_model).toBe("")
  })

  it("refuses an amount past the controller's ceiling before it is sent", () => {
    expect(budgetTooLarge(null)).toBe(false)
    expect(budgetTooLarge(10_000_000_000_000)).toBe(false)
    expect(budgetTooLarge(10_000_000_000_001)).toBe(true)
  })
})

// The form and its two shells read the same value type, so a setting added to
// the schema reaches all three without a prop added anywhere.
describe("the settings value type", () => {
  it("is the shape the API already answers with", () => {
    const value: ThreadSettings = threadSettingsFromDefaults(defaults)
    for (const field of THREAD_SETTINGS_FIELDS) expect(value).toHaveProperty(field)
  })
})
