import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { contextReadState, shortContextId, shortFingerprint, threadContextReads } from "../src/lib/thread-context-reads.ts"
import type { ThreadContextReadCall } from "../src/lib/thread-context-reads.ts"

const record = (id: number, payload: unknown, hashes: { read_hash?: string | null; current_hash?: string | null } = {}, created_at = id): ThreadContextReadCall => ({
  id, thread_id: "thread", kind: "response_output", payload, created_at,
  read_hash: hashes.read_hash ?? null,
  current_hash: hashes.current_hash ?? null,
})
const readCall = (id: number, contextId: string, hashes: { read_hash?: string | null; current_hash?: string | null } = {}) =>
  record(id, { type: "function_call", name: "read_context", call_id: `call-${id}`, arguments: JSON.stringify({ context_id: contextId }) }, hashes)

test("repeated reads collapse per Context and keep the order the Thread discovered them", () => {
  const reads = threadContextReads([
    readCall(11, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", { read_hash: "aaaaaaaaaaaaaaaa", current_hash: "aaaaaaaaaaaaaaaa" }),
    readCall(12, "c0ffee00-1111-2222-3333-444455556666"),
    readCall(27, "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F", { read_hash: "bbbbbbbbbbbbbbbb", current_hash: "cccccccccccccccc" }),
  ])
  assert.deepEqual(reads, [
    { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", calls: 2, first_record_id: 11, last_record_id: 27, last_read_at: 27, read_hash: "bbbbbbbbbbbbbbbb", current_hash: "cccccccccccccccc" },
    { context_id: "c0ffee00-1111-2222-3333-444455556666", calls: 1, first_record_id: 12, last_record_id: 12, last_read_at: 12, read_hash: null, current_hash: null },
  ])
})

test("the newest read decides whether the Context the Thread holds is still current", () => {
  const [reread] = threadContextReads([
    readCall(11, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", { read_hash: "aaaaaaaaaaaaaaaa", current_hash: "aaaaaaaaaaaaaaaa" }),
    readCall(27, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", { read_hash: "cccccccccccccccc", current_hash: "cccccccccccccccc" }),
  ])
  assert.equal(contextReadState(reread), "current")
})

test("a changed, unanswered or vanished Context is told apart from an unchanged one", () => {
  const read = (read_hash: string | null, current_hash: string | null) => ({
    context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", calls: 1, first_record_id: 1, last_record_id: 1, last_read_at: 1, read_hash, current_hash,
  })
  assert.equal(contextReadState(read("a".repeat(16), "a".repeat(16))), "current")
  assert.equal(contextReadState(read("a".repeat(16), "b".repeat(16))), "changed")
  assert.equal(contextReadState(read(null, "b".repeat(16))), "unanswered")
  assert.equal(contextReadState(read("a".repeat(16), null)), "missing")
})

test("only read_context calls count, and a call without a context id is dropped", () => {
  const reads = threadContextReads([
    record(1, { type: "function_call", name: "bash", call_id: "call-bash", arguments: JSON.stringify({ worker_id: "worker", command: "ls" }) }),
    record(2, { type: "function_call", name: "read_context", call_id: "call-broken", arguments: "{\"context_id\":" }),
    record(3, { type: "function_call", name: "read_context", call_id: "call-blank", arguments: JSON.stringify({ context_id: "  " }) }),
    record(4, { type: "function_call", name: "write_context", call_id: "call-write", arguments: JSON.stringify({ context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f" }) }),
    record(5, { type: "function_call_output", call_id: "call-write", output: "{}" }),
  ])
  assert.deepEqual(reads, [])
})

test("the chip shows short forms of the id and of the content fingerprint", () => {
  assert.equal(shortContextId("8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"), "8f1d2e3a")
  assert.equal(shortFingerprint("0123456789abcdef"), "01234567")
})

test("the Thread header asks for the reads endpoint and renders the indicator", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const indicator = readFileSync(new URL("../src/components/thread-context-reads.tsx", import.meta.url), "utf8")
  assert.match(main, /\/history\/reads`/)
  assert.match(main, /<ThreadContextReads reads=\{readContexts\}/)
  assert.match(indicator, /to=\{`\/contexts\?context=\$\{encodeURIComponent\(read\.context_id\)\}`\}/)
  assert.match(indicator, /contextReadState\(read\)/)
})
