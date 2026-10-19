import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { contextReadHash, threadContextReads } from "../src/lib/thread-context-reads.ts"
import type { HistoryRecord } from "../src/lib/thread-history.ts"

const record = (id: number, payload: unknown, created_at = id): HistoryRecord => ({ id, thread_id: "thread", kind: "response_output", payload, created_at })
const readCall = (id: number, contextId: string) => record(id, { type: "function_call", name: "read_context", call_id: `call-${id}`, arguments: JSON.stringify({ context_id: contextId }) })

test("repeated reads collapse per Context and keep the order the Thread discovered them", () => {
  const reads = threadContextReads([
    readCall(11, "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"),
    readCall(12, "c0ffee00-1111-2222-3333-444455556666"),
    readCall(27, "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F"),
  ])
  assert.deepEqual(reads, [
    { context_id: "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f", calls: 2, first_record_id: 11, last_record_id: 27, last_read_at: 27 },
    { context_id: "c0ffee00-1111-2222-3333-444455556666", calls: 1, first_record_id: 12, last_record_id: 12, last_read_at: 12 },
  ])
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

test("the hash is the short id the Contexts page link carries in full", () => {
  assert.equal(contextReadHash("8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"), "8f1d2e3a")
})

test("the Thread header asks for the reads endpoint and renders the indicator", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const indicator = readFileSync(new URL("../src/components/thread-context-reads.tsx", import.meta.url), "utf8")
  assert.match(main, /\/history\/reads`/)
  assert.match(main, /<ThreadContextReads reads=\{readContexts\}/)
  assert.match(indicator, /to=\{`\/contexts\?context=\$\{encodeURIComponent\(read\.context_id\)\}`\}/)
})
