import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { contextDirtyContexts, contextLoadNotice, threadContextReads, type ContextReadState, type ThreadContextReadCall } from "../src/lib/thread-context-reads.ts"
import type { HistoryRecord } from "../src/lib/thread-history.ts"

const record = (id: number, payload: unknown, state: ContextReadState = "current"): ThreadContextReadCall => ({ id, thread_id: "thread", kind: "response_output", payload, created_at: id, state })
const readCall = (id: number, contextId: string, state: ContextReadState = "current") =>
  record(id, { type: "function_call", name: "read_context", call_id: `call-${id}`, arguments: JSON.stringify({ context_id: contextId }) }, state)

test("repeated reads collapse per Context and keep the order the Thread discovered them", () => {
  const reads = threadContextReads([
    readCall(11, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"),
    readCall(12, "c0ffee00-1111-2222-3333-444455556666", "missing"),
    readCall(27, "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F", "changed"),
  ])
  assert.deepEqual(reads, [
    { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", calls: 2, first_record_id: 11, last_record_id: 27, last_read_at: 27, state: "changed" },
    { context_id: "c0ffee00-1111-2222-3333-444455556666", calls: 1, first_record_id: 12, last_record_id: 12, last_read_at: 12, state: "missing" },
  ])
})

test("the newest read decides the state of a Context the Thread read twice", () => {
  const [reread] = threadContextReads([
    readCall(11, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", "changed"),
    readCall(27, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", "current"),
  ])
  assert.equal(reread.state, "current")
})

test("only read_context calls count, and a call without a context id is dropped", () => {
  const reads = threadContextReads([
    record(1, { type: "function_call", name: "bash", call_id: "call-bash", arguments: JSON.stringify({ worker_id: "worker", command: "ls" }) }),
    record(2, { type: "function_call", name: "read_context", call_id: "call-broken", arguments: "{\"context_id\":" }),
    record(3, { type: "function_call", name: "read_context", call_id: "call-blank", arguments: JSON.stringify({ context_id: "  " }) }),
    record(4, { type: "function_call", name: "write_context", call_id: "call-write", arguments: JSON.stringify({ context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f" }) }),
  ])
  assert.deepEqual(reads, [])
})

test("the chip carries no id or fingerprint, and the Thread transcript asks for the states", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const indicator = readFileSync(new URL("../src/components/thread-context-reads.tsx", import.meta.url), "utf8")
  assert.match(main, /\/history\/reads`/)
  assert.match(main, /<ThreadContextReads reads=\{readContexts\}/)
  // The row is a transcript row, not header chrome: reading more Contexts scrolls away instead of shrinking the conversation.
  assert.ok(main.indexOf("<MessageScrollerContent") < main.indexOf("<ThreadContextReads reads={readContexts}"))
  assert.match(main, /<ContextDirtyNotice contexts=\{dirtyContexts\}/)
  assert.doesNotMatch(indicator, /shortContextId|shortFingerprint|read_hash|current_hash/)
  assert.match(indicator, /text\.state\[read\.state\]/)
})

test("a context_dirty activity names the Contexts the model was asked to re-read", () => {
  const notice: HistoryRecord = {
    id: 9, thread_id: "thread", kind: "activity", created_at: 9,
    payload: { type: "context_dirty", contexts: [
      { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", read_record_id: 11, current_hash: "aaaa" },
      { context_id: "c0ffee00-1111-2222-3333-444455556666", read_record_id: 12, current_hash: "bbbb" },
    ] },
  }
  assert.deepEqual(contextDirtyContexts(notice), ["8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", "c0ffee00-1111-2222-3333-444455556666"])
  assert.equal(contextDirtyContexts({ ...notice, kind: "input" }), null)
  assert.equal(contextDirtyContexts({ ...notice, payload: { type: "thread_control", action: "compact" } }), null)
  assert.equal(contextDirtyContexts({ ...notice, payload: { type: "context_dirty", contexts: [] } }), null)
})

test("a loaded Context travels as its own activity record, kept apart from reads", () => {
  const loaded: HistoryRecord = {
    id: 7, thread_id: "thread", kind: "activity", created_at: 7,
    payload: { type: "context_loaded", context_id: "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F", fingerprint: "aaaa", context: { id: "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F", content: "body" } },
  }
  assert.deepEqual(contextLoadNotice(loaded), { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", loaded: true })
  assert.deepEqual(contextLoadNotice({ ...loaded, payload: { type: "context_unloaded", context_id: "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F", reason: "released" } }), { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", loaded: false })
  // A load is Thread state, not a read: it never becomes a read chip.
  assert.deepEqual(threadContextReads([]), [])
  assert.equal(contextLoadNotice({ ...loaded, kind: "input" }), null)
  assert.equal(contextLoadNotice({ ...loaded, payload: { type: "context_dirty", contexts: [] } }), null)
})

test("the reads row shows loaded Contexts and the transcript renders the record", () => {
  const indicator = readFileSync(new URL("../src/components/thread-context-reads.tsx", import.meta.url), "utf8")
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(indicator, /view\.loaded/)
  assert.match(indicator, /LoadedContextChip/)
  assert.match(main, /<ContextLoadNotice notice=\{loadNotice\}/)
  assert.match(main, /contextLoadNotice\(record\)/)
})
