import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { readPackageSource } from "./package-source.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

// The fields come from the ThreadDefaults type itself, so a setting added later
// joins every reader of the schema automatically instead of being silently
// skipped — the handler that once compared fields by hand and left the
// speech-to-text model out is gone, and one list now feeds them all.
const typeBody = source.match(/type ThreadDefaults = \{([\s\S]*?)\n\}/)?.[1] ?? ""
const fields = [...typeBody.matchAll(/^ {2}(\w+): (.+)$/gm)].map(([, name]) => name)

const schema = readPackageSource("lib/thread-settings.ts")
// Every field name the schema names, in order, defaults included.
const schemaFields = [...schema.matchAll(/^ {2}(\w+): /gm)].map(([, name]) => name)
const overridden = schema.match(/const OVERRIDDEN = \[([\s\S]*?)\] as const satisfies/)![1]

test("the schema names every field the server returns", () => {
  assert.ok(typeBody, "ThreadDefaults type must stay parseable")
  assert.deepEqual(fields, [
    "model",
    "upstream_id",
    "reasoning_effort",
    "service_tier_fast",
    "context_budget_tokens",
    "minimal_mode",
    "image_generation_model",
    "audio_transcription_model",
    "max_loaded_manuals",
    "initial_manual_ids",
    "budget_usd_nanos",
  ])
  // The package's ThreadSettings type lists exactly those names.
  assert.deepEqual(schemaFields, [
    "model",
    "upstream_id",
    "reasoning_effort",
    "service_tier_fast",
    "context_budget_tokens",
    "minimal_mode",
    "image_generation_model",
    "audio_transcription_model",
    "max_loaded_manuals",
    "initial_manual_ids",
    "budget_usd_nanos",
  ])
})

test("every setting a Thread may override is in the one list the writers walk", () => {
  const nullable = ["context_budget_tokens", "minimal_mode", "image_generation_model", "audio_transcription_model", "max_loaded_manuals", "initial_manual_ids", "budget_usd_nanos"]
  for (const name of nullable) assert.ok(overridden.includes(`"${name}"`), `${name} must be an override`)
  // The four settings a Thread always holds are not overrides: they are written
  // as their own pair of fields (model with its upstream) or directly.
  for (const name of ["model", "upstream_id", "reasoning_effort", "service_tier_fast"]) assert.ok(!overridden.includes(`"${name}"`))
})

test("the schema carries one converter per source and one writer per target", () => {
  // The three surfaces read the same schema: a Thread row, the account defaults,
  // and a Thread that does not exist yet.
  for (const name of ["threadSettingsFromThread", "threadSettingsFromDefaults", "threadSettingsForNewThread"]) assert.match(schema, new RegExp(`export function ${name}\\(`))
  // And the two writers, one per endpoint shape.
  assert.match(schema, /export function threadSettingsPatch\(next: ThreadSettings, base: ThreadSettings\): ThreadPatch \| null/)
  assert.match(schema, /export function threadSettingsDefaults\(next: ThreadSettings, saved: ThreadSettings\): ThreadDefaults/)
  // A new Thread only names a model; it follows the account for the rest, which
  // is why creation sends nulls until the composer pins something.
  const newThread = schema.slice(schema.indexOf("export function threadSettingsForNewThread"), schema.indexOf("/** Whether two values hold the same settings"))
  for (const name of ["context_budget_tokens", "minimal_mode", "image_generation_model", "audio_transcription_model", "max_loaded_manuals", "initial_manual_ids", "budget_usd_nanos"]) {
    assert.match(newThread, new RegExp(`${name}: null`), `${name} must start as "follow the default"`)
  }
  assert.match(newThread, /model: defaults\.model/)
})

test("the defaults card compares the whole payload instead of naming fields by hand", () => {
  assert.match(source, /const payload = value !== null && saved !== null \? threadSettingsDefaults\(value, saved\) : null/)
  assert.match(source, /const changed = payload !== null && !sameThreadSettings\(threadSettingsFromDefaults\(payload\), saved!\)/)
  assert.doesNotMatch(source, /defaultsChanged\(/)
  assert.doesNotMatch(source, /value\.max_loaded_manuals !== defaults\.data\.max_loaded_manuals/)
  // The card renders the same control the other two surfaces render.
  assert.match(source, /<ThreadSettingsFields mode="defaults" idPrefix="default-thread" value=\{value\} onChange=\{edit\}/)
})
