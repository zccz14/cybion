import { describe, expect, it } from "vitest"

import { groupThreadHistory, inFlightCallIds, newestRecordId, oldestRecordId, recordInFlight, type HistoryRecord } from "../src/lib/thread-history"
import { pendingResponseRecords } from "../src/lib/thread-response"

const record = (id: number, kind: HistoryRecord["kind"], payload: unknown): HistoryRecord => ({
  id,
  thread_id: "t1",
  kind,
  payload,
  created_at: id,
})

describe("thread history", () => {
  it("keeps inputs and replies as messages and folds everything between them into one process group", () => {
    const records = [
      record(1, "input", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }),
      record(2, "response_output", { type: "reasoning", summary: [{ text: "thinking" }] }),
      record(3, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }),
      record(4, "input", { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] }),
    ]
    const entries = groupThreadHistory(records)
    expect(entries.map((entry) => entry.type)).toEqual(["message", "process", "message", "message"])
  })

  it("tracks the calls a worker still owes an answer for", () => {
    const records = [
      record(1, "response_output", { type: "function_call", call_id: "call-a", name: "bash" }),
      record(2, "response_output", { type: "function_call", call_id: "call-b", name: "bash" }),
      record(3, "tool_output", { type: "function_call_output", call_id: "call-a" }),
    ]
    const inFlight = inFlightCallIds(records)
    expect([...inFlight]).toEqual(["call-b"])
    expect(recordInFlight(records[1], inFlight)).toBe(true)
    expect(recordInFlight(records[0], inFlight)).toBe(false)
  })

  it("reports the cursor pair used for incremental polling", () => {
    const records = [record(3, "input", {}), record(9, "input", {})]
    expect(oldestRecordId(records)).toBe(3)
    expect(newestRecordId(records)).toBe(9)
  })

  it("shows in-flight streamed items that are not stored yet", () => {
    const history = [{ id: 5 }]
    const view = {
      started_at: 100,
      status: "running",
      response: { completed: false, output: [
        { item: { type: "message", content: [{ type: "output_text", text: "streaming" }] }, done: false, record_id: null },
        { item: { type: "message", content: [] }, done: true, record_id: 5 },
      ] },
    }
    const pending = pendingResponseRecords(view, history, "t1")
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe(-1)
  })

  it("folds the frozen request tail into the process group it was written for", () => {
    const records = [
      record(1, "input", { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }),
      record(2, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }),
      // The spend header the controller froze for the next inference: a fact about the Thread's
      // machinery, never a message of its own.
      record(3, "activity", { type: "request_tail", text: "[spend] 1.0k tokens total", spend: { requests: 1 } }),
      record(4, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "again" }] }),
    ]
    const entries = groupThreadHistory(records)
    expect(entries.map((entry) => entry.type)).toEqual(["message", "message", "process", "message"])
    const folded = entries[2]
    expect(folded.type === "process" ? folded.records.map((item) => item.id) : []).toEqual([3])
  })
})
