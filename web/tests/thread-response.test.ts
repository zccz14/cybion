import assert from "node:assert/strict"
import test from "node:test"
import { pendingResponseRecords, type ThreadResponseView } from "../src/lib/thread-response.ts"

test("streamed reasoning and messages become history rows without duplicating committed output", () => {
  const view: ThreadResponseView = {
    audit_id: 1, input_record_id: 10, started_at: 100, status: "in_flight",
    response: {
      response_id: "r", completed: false, server_model: "model", model_verifications: [], safety_buffering: null, rate_limits: [], usage: null, error: null,
      output: [
        { item: { type: "reasoning", summary: [{ type: "summary_text", text: "checking" }] }, done: true, record_id: 11 },
        { item: { type: "message", content: [{ type: "output_text", text: "hello" }] }, done: false, record_id: null },
      ],
    },
  }
  assert.deepEqual(pendingResponseRecords(view, [], "thread")[0].payload, view.response.output[0].item)
  const live = pendingResponseRecords(view, [{ id: 11 }], "thread")
  assert.equal(live.length, 1)
  assert.deepEqual(live[0], {
    id: -2, thread_id: "thread", kind: "response_output", payload: view.response.output[1].item, created_at: 100,
  })
  view.response.output[1].done = true
  view.response.output[1].record_id = 12
  assert.deepEqual(pendingResponseRecords(view, [{ id: 11 }, { id: 12 }], "thread"), [])
})
