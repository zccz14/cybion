import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { bashFunctionCall, browserControlFunctionCall, computerUseFunctionCall, cybionToolFunctionCall, imageGenerationFunctionCall, webSearchFunctionCall } from "../src/lib/history-payload.ts"

const families = [bashFunctionCall, browserControlFunctionCall, computerUseFunctionCall, cybionToolFunctionCall, webSearchFunctionCall, imageGenerationFunctionCall]

const samples: Record<string, unknown> = {
  bash: { type: "function_call", name: "bash", arguments: '{"worker_id":"worker-1","command":"pwd"}' },
  browser_control: { type: "function_call", name: "browser_control", arguments: '{"action":"screenshot"}' },
  computer_use: { type: "function_call", name: "computer_use", arguments: '{"action":"screenshot"}' },
  read_context: { type: "function_call", name: "read_context", arguments: '{"context_id":"ctx-1"}' },
  write_context: { type: "function_call", name: "write_context", arguments: '{"name":"Notes","parent_id":"ctx-1"}' },
  cybion_list_contexts: { type: "function_call", name: "cybion_list_contexts", arguments: "{}" },
  cybion_list_workers: { type: "function_call", name: "cybion_list_workers", arguments: "{}" },
  cybion_list_ultimate_machines: { type: "function_call", name: "cybion_list_ultimate_machines", arguments: "{}" },
  cybion_get_ultimate_machine: { type: "function_call", name: "cybion_get_ultimate_machine", arguments: '{"machine_id":"machine-1"}' },
  cybion_set_ultimate_machine: { type: "function_call", name: "cybion_set_ultimate_machine", arguments: '{"name":"磁盘检查","worker_id":"worker-1","command":"df -h","interval_seconds":600}' },
  normai_web_search: { type: "function_call", name: "normai_web_search", arguments: '{"query":"rust release"}' },
  normai_image_generation: { type: "function_call", name: "normai_image_generation", arguments: '{"prompt":"a dog"}' },
}

// INVARIANT: every built-in tool in tools.json needs its own renderer matcher;
// this test fails when a tool is added or a matcher is dropped.
test("every built-in tool in the catalog has exactly one renderer matcher", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../tools.json", import.meta.url), "utf8"))
  const names = [
    ...catalog.context.map((tool: { name: string }) => tool.name),
    ...catalog.worker.map((tool: { name: string }) => tool.name),
    ...Object.keys(catalog.native),
  ]
  for (const name of names) {
    assert.ok(name in samples, `no renderer sample for ${name}`)
    const accepting = families.filter((matcher) => matcher(samples[name]) !== null)
    assert.equal(accepting.length, 1, `expected exactly one renderer matcher for ${name}`)
  }
  for (const name of Object.keys(samples)) {
    assert.ok(names.includes(name), `stale renderer sample for ${name}`)
  }
})

test("thread view dispatches every tool renderer before the generic protocol fallback", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const generic = source.indexOf('if (typeof payload?.type === "string" &&')
  assert.ok(generic > 0)
  for (const matcher of ["bashFunctionCall(payload)", "webSearchFunctionCall(payload)", "imageGenerationFunctionCall(payload)", "browserControlFunctionCall(payload)", "computerUseFunctionCall(payload)", "cybionToolFunctionCall(payload)"]) {
    const at = source.indexOf(matcher)
    assert.ok(at !== -1, `missing dispatch for ${matcher}`)
    assert.ok(at < generic, `${matcher} must run before the generic fallback`)
  }
  for (const component of ["<BashCommand ", "<WebSearchCall ", "<ImageGenerationCall ", "<BrowserControlCall ", "<ComputerUseCall ", "<CybionToolCall "]) {
    const at = source.indexOf(component)
    assert.ok(at !== -1, `missing component dispatch for ${component}`)
    assert.ok(at < generic, `${component} must render before the generic fallback`)
  }
})
