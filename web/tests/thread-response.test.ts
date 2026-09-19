import assert from "node:assert/strict"
import test from "node:test"
import { pendingResponseRecords, threadControlAction, type ThreadResponseView } from "../src/lib/thread-response.ts"

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
  view.status = "cancelled"
  assert.deepEqual(pendingResponseRecords(view, [], "thread"), [], "cancelled previews must not display unsaved partial output")
})

test("thread control records are recognized without treating input as controls", () => {
  const compact = { kind: "activity", payload: { type: "thread_control", action: "compact" } }
  assert.equal(threadControlAction(compact), "compact")
  assert.equal(threadControlAction({ ...compact, payload: { type: "thread_control", action: "cancel" } }), "cancel")
  assert.equal(threadControlAction({ ...compact, payload: { type: "thread_control", action: "continue" } }), "continue")
  assert.equal(threadControlAction({ ...compact, kind: "input" }), null)
  assert.equal(threadControlAction({ kind: "activity", payload: null }), null)
})
