import assert from "node:assert/strict"
import test from "node:test"
import { bashFunctionCall, browserControlFunctionCall, computerUseFunctionCall, cybionToolFunctionCall, historyPayloadText, imageGenerationFunctionCall, userInputView, webSearchFunctionCall } from "../src/lib/history-payload.ts"

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
    { ...valid, name: "unknown_tool" },
    ...[undefined, null, {}, "", "{", "null", "[]", "42", '"text"', "{}",
      '{"worker_id":"worker-1"}', '{"command":"pwd"}',
      '{"worker_id":3,"command":"pwd"}', '{"worker_id":"worker-1","command":[]}',
    ].map((argumentsValue) => ({ ...valid, arguments: argumentsValue })),
  ]) {
    assert.equal(bashFunctionCall(payload), null, JSON.stringify(payload))
  }
})

test("user input splits typed text from pasted images", () => {
  assert.deepEqual(userInputView({ role: "user", content: "plain text" }), { text: "plain text", images: [] })
  const png = "data:image/png;base64,AAAA"
  const jpeg = "data:image/jpeg;base64,BBBB"
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_text", text: "这个报错怎么回事？" }, { type: "input_image", image_url: png }, { type: "input_image", image_url: jpeg }] }),
    { text: "这个报错怎么回事？", images: [png, jpeg] },
  )
  assert.deepEqual(userInputView({ role: "user", content: [{ type: "input_image", image_url: png }] }), { text: "", images: [png] })
  assert.deepEqual(userInputView(null), { text: "", images: [] })
})

test("native search and image tool calls expose query, prompt and reference positions", () => {
  assert.deepEqual(
    webSearchFunctionCall({ type: "function_call", name: "normai_web_search", arguments: JSON.stringify({ query: "  rust release  " }) }),
    { query: "rust release" },
  )
  assert.deepEqual(
    imageGenerationFunctionCall({ type: "function_call", name: "normai_image_generation", arguments: JSON.stringify({ prompt: "  一只戴墨镜的柴犬  ", reference_images: [2, 1] }) }),
    { prompt: "一只戴墨镜的柴犬", referenceImages: [2, 1] },
  )
  assert.deepEqual(
    imageGenerationFunctionCall({ type: "function_call", name: "normai_image_generation", arguments: JSON.stringify({ prompt: "纯文生图" }) }),
    { prompt: "纯文生图", referenceImages: [] },
  )
})

test("unrelated events and malformed native tool arguments keep the generic protocol renderer", () => {
  const search = { type: "function_call", name: "normai_web_search", arguments: '{"query":"rust"}' }
  const image = { type: "function_call", name: "normai_image_generation", arguments: '{"prompt":"dog"}' }
  for (const payload of [
    null, [], "text", {},
    { ...search, type: "function_call_output" },
    { ...search, name: "bash" },
    image,
    ...[undefined, null, {}, "", "{\"query\":", "42", "[]", "{}",
      '{"query":""}', '{"query":"   "}', '{"query":3}',
    ].map((argumentsValue) => ({ ...search, arguments: argumentsValue })),
  ]) {
    assert.equal(webSearchFunctionCall(payload), null, JSON.stringify(payload))
  }
  for (const payload of [
    null, [], "text", {},
    { ...image, type: "function_call_output" },
    { ...image, name: "normai_web_search" },
    search,
    ...[undefined, null, {}, "", "{\"prompt\":", "42", "[]", "{}",
      '{"prompt":""}', '{"prompt":"   "}', '{"prompt":42}',
    ].map((argumentsValue) => ({ ...image, arguments: argumentsValue })),
  ]) {
    assert.equal(imageGenerationFunctionCall(payload), null, JSON.stringify(payload))
  }
  // Positions that cannot name an attached picture drop out of the display line.
  assert.deepEqual(
    imageGenerationFunctionCall({ ...image, arguments: JSON.stringify({ prompt: "dog", reference_images: "1" }) }),
    { prompt: "dog", referenceImages: [] },
  )
  assert.deepEqual(
    imageGenerationFunctionCall({ ...image, arguments: JSON.stringify({ prompt: "dog", reference_images: [0, 1.5, "2", 3] }) }),
    { prompt: "dog", referenceImages: [3] },
  )
})

test("browser and desktop calls expose their action payloads", () => {
  const browser = (args: unknown) => ({ type: "function_call", name: "browser_control", arguments: JSON.stringify(args) })
  for (const [payload, expected] of [
    [browser({ action: "navigate", url: "https://example.com" }), { action: "navigate", url: "https://example.com" }],
    [browser({ action: "open", url: "https://example.com" }), { action: "open", url: "https://example.com" }],
    [browser({ action: "evaluate", text: " document.title " }), { action: "evaluate", text: "document.title" }],
    [browser({ action: "click", selector: "#submit" }), { action: "click", selector: "#submit" }],
    [browser({ action: "type", selector: "#q", text: "rust" }), { action: "type", selector: "#q", text: "rust" }],
    [browser({ action: "screenshot" }), { action: "screenshot" }],
  ] as const) {
    assert.deepEqual(browserControlFunctionCall(payload), expected)
  }
  const computer = (args: unknown) => ({ type: "function_call", name: "computer_use", arguments: JSON.stringify(args) })
  for (const [payload, expected] of [
    [computer({ action: "move", x: 100, y: 200 }), { action: "move", x: 100, y: 200 }],
    [computer({ action: "click", x: 30, y: 40 }), { action: "click", x: 30, y: 40 }],
    [computer({ action: "type", text: " hello " }), { action: "type", text: "hello" }],
    [computer({ action: "screenshot" }), { action: "screenshot" }],
  ] as const) {
    assert.deepEqual(computerUseFunctionCall(payload), expected)
  }
})

test("incomplete or unknown worker actions retain the generic protocol renderer", () => {
  for (const payload of [
    null, [], "text", {},
    { type: "function_call_output", name: "browser_control", arguments: '{"action":"screenshot"}' },
    { type: "function_call", name: "bash", arguments: '{"action":"screenshot"}' },
    { type: "function_call", name: "computer_use", arguments: '{"action":"screenshot"}' },
    ...[undefined, null, {}, "", "{", "null", "[]", "42",
      '{"action":""}', '{"action":"navigate"}', '{"action":"navigate","url":3}', '{"action":"navigate","url":"  "}',
      '{"action":"click"}', '{"action":"click","selector":""}',
      '{"action":"type","selector":"#q"}', '{"action":"type","text":"x"}',
      '{"action":"scroll"}', '{"action":"SCREENSHOT"}',
    ].map((argumentsValue) => ({ type: "function_call", name: "browser_control", arguments: argumentsValue })),
  ]) {
    assert.equal(browserControlFunctionCall(payload), null, JSON.stringify(payload))
  }
  for (const payload of [
    null, [], "text", {},
    { type: "function_call_output", name: "computer_use", arguments: '{"action":"screenshot"}' },
    { type: "function_call", name: "browser_control", arguments: '{"action":"screenshot"}' },
    ...[undefined, null, {}, "", "{", "null", "[]", "42",
      '{"action":"move"}', '{"action":"move","x":1}', '{"action":"click","x":1.5,"y":2}', '{"action":"click","x":"1","y":2}',
      '{"action":"type"}', '{"action":"type","text":""}',
      '{"action":"keypress"}',
    ].map((argumentsValue) => ({ type: "function_call", name: "computer_use", arguments: argumentsValue })),
  ]) {
    assert.equal(computerUseFunctionCall(payload), null, JSON.stringify(payload))
  }
})

test("cybion tool calls expose context and machine arguments", () => {
  const call = (name: string, args: unknown) => ({ type: "function_call", name, arguments: JSON.stringify(args) })
  assert.deepEqual(cybionToolFunctionCall(call("read_context", { context_id: "  ctx-1  " })), { tool: "read_context", contextId: "ctx-1" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_list_contexts", {})), { tool: "cybion_list_contexts" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_list_workers", {})), { tool: "cybion_list_workers" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_list_ultimate_machines", {})), { tool: "cybion_list_ultimate_machines" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_get_ultimate_machine", { machine_id: "m-1" })), { tool: "cybion_get_ultimate_machine", machineId: "m-1" })
  assert.deepEqual(
    cybionToolFunctionCall(call("cybion_set_ultimate_machine", { machine_id: "m-1", name: " 磁盘检查 ", interval_seconds: 600, enabled: false, command: "df -h", intent: " 确保根分区低于 90% " })),
    { tool: "cybion_set_ultimate_machine", machineId: "m-1", name: "磁盘检查", workerId: null, intervalSeconds: 600, enabled: false, command: "df -h", intent: "确保根分区低于 90%" },
  )
  assert.deepEqual(
    cybionToolFunctionCall(call("cybion_set_ultimate_machine", { name: "磁盘检查", worker_id: "worker-1", command: "df -h", interval_seconds: 600 })),
    { tool: "cybion_set_ultimate_machine", machineId: null, name: "磁盘检查", workerId: "worker-1", intervalSeconds: 600, enabled: null, command: "df -h", intent: null },
  )
})

test("incomplete or unknown cybion tool arguments retain the generic protocol renderer", () => {
  const call = (name: string, argumentsValue: unknown) => ({ type: "function_call", name, arguments: argumentsValue })
  for (const payload of [
    null, [], "text", {},
    call("read_context", "{}"),
    call("read_context", '{"context_id":""}'),
    call("cybion_get_ultimate_machine", "{}"),
    call("cybion_set_ultimate_machine", "{}"),
    call("cybion_set_ultimate_machine", '{"enabled":"yes"}'),
    call("cybion_list_contexts", "not json"),
    { type: "function_call_output", name: "read_context", arguments: "{}" },
    call("bash", '{"worker_id":"worker-1","command":"pwd"}'),
  ] as const) {
    assert.equal(cybionToolFunctionCall(payload), null, JSON.stringify(payload))
  }
})
