import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { defaultsChanged } from "../src/lib/thread-defaults.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

// The fields come from the ThreadDefaults type itself, so a setting added later
// joins the dirty check automatically instead of being silently skipped.
const typeBody = source.match(/type ThreadDefaults = \{([\s\S]*?)\n\}/)?.[1] ?? ""
const fields = [...typeBody.matchAll(/^ {2}(\w+): (.+)$/gm)].map(([, name, type]) => ({ name, type: type.trim() }))

function sample(type: string, variant: 0 | 1) {
  if (type === "boolean") return variant === 0
  if (type === "number") return variant === 0 ? 12 : 13
  if (type.includes("| null")) return variant === 0 ? "model-a" : "model-b"
  if (type.startsWith("typeof REASONING_EFFORTS")) return variant === 0 ? "low" : "high"
  return variant === 0 ? "model-a" : "model-b"
}

test("the defaults dirty check covers every field the server returns", () => {
  assert.ok(typeBody, "ThreadDefaults type must stay parseable")
  assert.deepEqual(fields.map((field) => field.name), [
    "model",
    "upstream_id",
    "reasoning_effort",
    "service_tier_fast",
    "context_budget_tokens",
    "minimal_mode",
    "image_generation_model",
    "audio_transcription_model",
    "max_loaded_manuals",
  ])
})

test("an untouched draft leaves the save button disabled", () => {
  const saved = Object.fromEntries(fields.map((field) => [field.name, sample(field.type, 0)]))
  assert.equal(defaultsChanged(saved, saved), false)
})

test("changing any single default enables the save button", () => {
  const saved = Object.fromEntries(fields.map((field) => [field.name, sample(field.type, 0)]))
  for (const field of fields) {
    assert.equal(defaultsChanged({ ...saved, [field.name]: sample(field.type, 1) }, saved), true, `${field.name} must count as a change`)
  }
})

test("changing only the speech-to-text model is a change worth saving", () => {
  const saved = Object.fromEntries(fields.map((field) => [field.name, sample(field.type, 0)]))
  assert.equal(defaultsChanged({ ...saved, audio_transcription_model: "gpt-4o-transcribe" }, saved), true)
  assert.equal(defaultsChanged({ ...saved, audio_transcription_model: null }, saved), true)
})

test("the defaults card compares the whole payload instead of naming fields by hand", () => {
  assert.match(source, /const changed = value && defaults\.data && defaultsChanged\(value, defaults\.data\)/)
  assert.doesNotMatch(source, /value\.max_loaded_manuals !== defaults\.data\.max_loaded_manuals/)
})
