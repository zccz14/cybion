import assert from "node:assert/strict"
import test from "node:test"
import { bashFunctionCall, historyPayloadText } from "../src/lib/history-payload.ts"

test("conversation text is derived from stored protocol payloads", () => {
  for (const [payload, expected] of [
    [{ role: "user", content: "User input" }, "User input"],
    [{ role: "developer", content: "Checkpoint" }, "Checkpoint"],
    [{ role: "system", content: "Request failed: unavailable" }, "Request failed: unavailable"],
    [{ type: "message", content: [{ type: "output_text", text: "Hello" }, { type: "refusal", refusal: " world" }] }, "Hello world"],
    [{ type: "message", content: [] }, ""],
    [{ type: "reasoning", summary: [{ type: "summary_text", text: "First" }, { type: "summary_text", text: "Second" }] }, "First\n\nSecond"],
    [{ type: "function_call_output", output: "Tool result" }, "Tool result"],
  ] as const) {
    assert.equal(historyPayloadText(payload), expected)
  }
  const protocol = { type: "web_search_call", action: { query: "Cybion" } }
  assert.equal(historyPayloadText(protocol), JSON.stringify(protocol, null, 2))
})

test("bash function calls preserve multiline commands and exact Worker IDs", () => {
  const command = 'cd ~/Projects/cybion\nprintf "你好\\n"'
  const payload = { type: "function_call", name: "bash", arguments: JSON.stringify({ worker_id: "worker-1", command }) }
  assert.deepEqual(bashFunctionCall(payload), { workerId: "worker-1", command })
})

test("unrelated events and incomplete or malformed bash arguments retain the generic protocol renderer", () => {
  const valid = { type: "function_call", name: "bash", arguments: '{"worker_id":"worker-1","command":"pwd"}' }
  for (const payload of [
    null, [], "bash", {},
    { ...valid, type: "function_call_output" },
    { ...valid, name: "browser_control" },
    ...[undefined, null, {}, "", "{", "null", "[]", "42", '"text"', "{}",
      '{"worker_id":"worker-1"}', '{"command":"pwd"}',
      '{"worker_id":3,"command":"pwd"}', '{"worker_id":"worker-1","command":[]}',
    ].map((argumentsValue) => ({ ...valid, arguments: argumentsValue })),
  ]) {
    assert.equal(bashFunctionCall(payload), null, JSON.stringify(payload))
  }
})
