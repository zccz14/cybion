import assert from "node:assert/strict"
import test from "node:test"

import { contextDraft, draftsMatch, shouldAutosave } from "../src/lib/context-drafts.ts"

const saved = { id: "a", name: "A", description: "why", content: "body", parent_id: null }

test("a draft copies the context fields and defaults the missing ones", () => {
  assert.deepEqual(contextDraft({ id: "a", name: "A", description: "why", content: "body", parent_id: "p" }), { ...saved, parent_id: "p" })
  assert.deepEqual(contextDraft(), { id: null, name: "", description: "", content: "", parent_id: null })
})

test("drafts match only while every field is unchanged", () => {
  assert.equal(draftsMatch(saved, { ...saved }), true)
  for (const change of [{ id: "b" }, { name: "B" }, { description: "" }, { content: "" }, { parent_id: "p" }]) {
    assert.equal(draftsMatch(saved, { ...saved, ...change }), false)
  }
})

test("only named, existing, changed drafts auto-save while nothing is in flight", () => {
  const edited = { ...saved, content: "edited" }
  assert.equal(shouldAutosave(edited, saved, false), true)
  assert.equal(shouldAutosave(edited, null, false), true)
  assert.equal(shouldAutosave(edited, saved, true), false)
  assert.equal(shouldAutosave(saved, saved, false), false)
  assert.equal(shouldAutosave({ ...edited, id: null }, null, false), false)
  assert.equal(shouldAutosave({ ...edited, name: "  " }, saved, false), false)
  assert.equal(shouldAutosave(null, saved, false), false)
})
