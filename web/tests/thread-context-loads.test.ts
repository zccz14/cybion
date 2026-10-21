import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { contextLoadNotice } from "../src/lib/thread-context-loads.ts"
import type { HistoryRecord } from "../src/lib/thread-history.ts"

const context = "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F"
const loaded: HistoryRecord = {
  id: 7, thread_id: "thread", kind: "activity", created_at: 7,
  payload: { type: "context_loaded", context_id: context, fingerprint: "aaaa", context: { id: context, name: "必读上下文", content: "body" } },
}

test("a loaded Context travels as its own activity record", () => {
  assert.deepEqual(contextLoadNotice(loaded), { context_id: context.toLowerCase(), loaded: true })
  assert.deepEqual(
    contextLoadNotice({ ...loaded, payload: { type: "context_unloaded", context_id: context, reason: "released" } }),
    { context_id: context.toLowerCase(), loaded: false },
  )
  assert.equal(contextLoadNotice({ ...loaded, kind: "input" }), null)
  assert.equal(contextLoadNotice({ ...loaded, payload: { type: "thread_control", action: "compact" } }), null)
  assert.equal(contextLoadNotice({ ...loaded, payload: { type: "context_loaded" } }), null)
})

test("a retired context_dirty record is not a load notice", () => {
  const dirty: HistoryRecord = {
    id: 9, thread_id: "thread", kind: "activity", created_at: 9,
    payload: { type: "context_dirty", contexts: [{ context_id: context, read_record_id: 11, current_hash: "aaaa" }] },
  }
  assert.equal(contextLoadNotice(dirty), null)
})

test("the transcript row reads the loaded bindings and nothing re-reads them", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const indicator = readFileSync(new URL("../src/components/thread-context-loads.tsx", import.meta.url), "utf8")
  assert.match(main, /\/history\/loaded`/)
  assert.match(main, /<ThreadContextLoads view=\{contextLoads.data\}/)
  // The row is a transcript row, not header chrome: loading more Contexts scrolls away instead of shrinking the conversation.
  assert.ok(main.indexOf("<MessageScrollerContent") < main.indexOf("<ThreadContextLoads view="))
  assert.match(main, /<ContextLoadNotice notice=\{loadNotice\}/)
  assert.match(main, /contextLoadNotice\(record\)/)
  // The retired read tool and its stale-copy notices are gone from the client.
  assert.doesNotMatch(main, /read_context/)
  assert.doesNotMatch(main, /history\/reads/)
  assert.doesNotMatch(main, /context_dirty/)
  assert.match(indicator, /view\.loaded/)
  assert.match(indicator, /text\.loadedLabel/)
  assert.doesNotMatch(indicator, /state\[|fingerprint/)
})
