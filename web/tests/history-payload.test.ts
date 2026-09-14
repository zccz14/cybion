import assert from "node:assert/strict"
import test from "node:test"
import { historyPayloadText } from "../src/lib/history-payload.ts"

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
