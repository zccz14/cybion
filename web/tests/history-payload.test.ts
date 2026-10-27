import assert from "node:assert/strict"
import test from "node:test"
import { bashCallCountdown, bashFunctionCall, browserControlFunctionCall, computerUseFunctionCall, cybionToolFunctionCall, historyPayloadText, imageGenerationFunctionCall, userInputView, viewImageFunctionCall, webSearchFunctionCall } from "../src/lib/history-payload.ts"

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

test("bash function calls preserve the intent summary, multiline commands, the call id and both clocks", () => {
  const command = 'cd ~/Projects/cybion\nprintf "你好\\n"'
  const payload = { type: "function_call", id: "fc-1", call_id: "call-1", name: "bash", arguments: JSON.stringify({ worker_id: "worker-1", summary: "  inspect the workspace  ", command, delay_seconds: 30, timeout_seconds: 900 }) }
  assert.deepEqual(bashFunctionCall(payload), { callId: "call-1", workerId: "worker-1", summary: "inspect the workspace", command, delaySeconds: 30, timeoutSeconds: 900 })
  const bare = { type: "function_call", name: "bash", arguments: JSON.stringify({ worker_id: "worker-1", command }) }
  assert.deepEqual(bashFunctionCall(bare), { callId: null, workerId: "worker-1", summary: null, command, delaySeconds: null, timeoutSeconds: null })
  // The tool accepts whole seconds of at least 1; anything else is no clock at all.
  for (const value of [0, -5, 1.5, "60", null, true]) {
    const arguments_ = JSON.stringify({ worker_id: "worker-1", command, delay_seconds: value, timeout_seconds: value })
    assert.deepEqual(bashFunctionCall({ ...bare, arguments: arguments_ }), { callId: null, workerId: "worker-1", summary: null, command, delaySeconds: null, timeoutSeconds: null }, String(value))
  }
})

test("bash countdowns chain the controller delay into the Worker timeout", () => {
  const call = { callId: "call-1", workerId: "worker-1", summary: null, command: "pwd", delaySeconds: 60, timeoutSeconds: 300 }
  const startedAt = 1_000
  // The delay is served in the controller and the timeout clock starts where it ends.
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt), { phase: "delayed", seconds: 60 })
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt + 59), { phase: "delayed", seconds: 1 })
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt + 60), { phase: "running", seconds: 300 })
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt + 359), { phase: "running", seconds: 1 })
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt + 360), { phase: "expired" })
  // A call that names no timeout runs against the tool's documented default.
  const undelayed = { ...call, delaySeconds: null, timeoutSeconds: null }
  assert.deepEqual(bashCallCountdown(undelayed, startedAt, startedAt + 599), { phase: "running", seconds: 1 })
  assert.deepEqual(bashCallCountdown(undelayed, startedAt, startedAt + 600), { phase: "expired" })
  // A browser clock behind the server never inflates either countdown.
  assert.deepEqual(bashCallCountdown(call, startedAt, startedAt - 30), { phase: "delayed", seconds: 60 })
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

test("user input splits typed text from pasted images and voice clips", () => {
  assert.deepEqual(userInputView({ role: "user", content: "plain text" }), { text: "plain text", images: [], audios: [] })
  const png = "data:image/png;base64,AAAA"
  const jpeg = "data:image/jpeg;base64,BBBB"
  const voice = "data:audio/webm;base64,CCCC"
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_text", text: "这个报错怎么回事？" }, { type: "input_image", image_url: png }, { type: "input_image", image_url: jpeg }] }),
    { text: "这个报错怎么回事？", images: [png, jpeg], audios: [] },
  )
  assert.deepEqual(userInputView({ role: "user", content: [{ type: "input_image", image_url: png }] }), { text: "", images: [png], audios: [] })
  // A voice message carries no text: it must survive as its own kind of input.
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_audio", audio_url: voice }] }),
    { text: "", images: [], audios: [{ audioUrl: voice, audioRef: null, mediaType: null }] },
  )
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_text", text: "听一下" }, { type: "input_audio", audio_url: voice }] }),
    { text: "听一下", images: [], audios: [{ audioUrl: voice, audioRef: null, mediaType: null }] },
  )
  // Records written before the note moved onto the audio part still carry the
  // provisional transcript as text; it must not render as the user's words.
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_audio", audio_ref: "c".repeat(64), media_type: "audio/webm" }, { type: "input_text", text: "[audio attachment ref=" + "c".repeat(64) + " type=audio/webm] provisional transcript (m):\n你好" }] }),
    { text: "", images: [], audios: [{ audioUrl: null, audioRef: "c".repeat(64), mediaType: "audio/webm" }] },
  )
  // Stored history externalises the bytes: what comes back is a reference, and
  // the voice bar has to fetch the clip before it can play it.
  const reference = "a".repeat(64)
  assert.deepEqual(
    userInputView({ role: "user", content: [{ type: "input_audio", audio_ref: reference, media_type: "audio/webm" }] }),
    { text: "", images: [], audios: [{ audioUrl: null, audioRef: reference, mediaType: "audio/webm" }] },
  )
  assert.deepEqual(userInputView(null), { text: "", images: [], audios: [] })
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

test("view image calls expose the intent summary and the image path", () => {
  const call = (args: unknown) => ({ type: "function_call", name: "view_image", arguments: JSON.stringify(args) })
  assert.deepEqual(
    viewImageFunctionCall(call({ worker_id: "worker-1", summary: "  check the rendered page  ", path: "/tmp/page.png" })),
    { workerId: "worker-1", summary: "check the rendered page", path: "/tmp/page.png" },
  )
  assert.deepEqual(viewImageFunctionCall(call({ worker_id: "worker-1", path: "/tmp/page.png" })), { workerId: "worker-1", summary: null, path: "/tmp/page.png" })
})

test("browser and desktop calls expose the intent summary and their action payloads", () => {
  const browser = (args: unknown) => ({ type: "function_call", name: "browser_control", arguments: JSON.stringify(args) })
  for (const [payload, expected] of [
    [browser({ summary: "  open the docs  ", action: "navigate", url: "https://example.com" }), { summary: "open the docs", action: "navigate", url: "https://example.com" }],
    [browser({ action: "open", url: "https://example.com" }), { summary: null, action: "open", url: "https://example.com" }],
    [browser({ action: "evaluate", text: " document.title " }), { summary: null, action: "evaluate", text: "document.title" }],
    [browser({ action: "click", selector: "#submit" }), { summary: null, action: "click", selector: "#submit" }],
    [browser({ action: "type", selector: "#q", text: "rust" }), { summary: null, action: "type", selector: "#q", text: "rust" }],
    [browser({ action: "screenshot" }), { summary: null, action: "screenshot" }],
  ] as const) {
    assert.deepEqual(browserControlFunctionCall(payload), expected)
  }
  const computer = (args: unknown) => ({ type: "function_call", name: "computer_use", arguments: JSON.stringify(args) })
  for (const [payload, expected] of [
    [computer({ summary: "move the pointer over the canvas", action: "move", x: 100, y: 200 }), { summary: "move the pointer over the canvas", action: "move", x: 100, y: 200 }],
    [computer({ action: "click", x: 30, y: 40 }), { summary: null, action: "click", x: 30, y: 40 }],
    [computer({ action: "type", text: " hello " }), { summary: null, action: "type", text: "hello" }],
    [computer({ action: "screenshot" }), { summary: null, action: "screenshot" }],
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

test("cybion tool calls expose manual and machine arguments", () => {
  const call = (name: string, args: unknown) => ({ type: "function_call", name, arguments: JSON.stringify(args) })
  assert.deepEqual(cybionToolFunctionCall(call("load_manual", { manual_id: "  ctx-1  " })), { tool: "load_manual", manualId: "ctx-1" })
  assert.deepEqual(cybionToolFunctionCall(call("unload_manual", { manual_id: "ctx-1" })), { tool: "unload_manual", manualId: "ctx-1" })
  assert.deepEqual(cybionToolFunctionCall(call("list_manuals", {})), { tool: "list_manuals" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_list_workers", {})), { tool: "cybion_list_workers" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_list_ultimate_machines", {})), { tool: "cybion_list_ultimate_machines" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_get_ultimate_machine", { machine_id: "m-1" })), { tool: "cybion_get_ultimate_machine", machineId: "m-1" })
  assert.deepEqual(cybionToolFunctionCall(call("cybion_delete_ultimate_machine", { machine_id: " m-1 " })), { tool: "cybion_delete_ultimate_machine", machineId: "m-1" })
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
    call("load_manual", "{}"),
    call("load_manual", '{"manual_id":""}'),
    call("cybion_get_ultimate_machine", "{}"),
    call("cybion_delete_ultimate_machine", "{}"),
    call("cybion_set_ultimate_machine", "{}"),
    call("cybion_set_ultimate_machine", '{"enabled":"yes"}'),
    call("list_manuals", "not json"),
    { type: "function_call_output", name: "load_manual", arguments: "{}" },
    call("bash", '{"worker_id":"worker-1","command":"pwd"}'),
  ] as const) {
    assert.equal(cybionToolFunctionCall(payload), null, JSON.stringify(payload))
  }
})
