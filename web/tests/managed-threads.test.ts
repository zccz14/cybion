import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("hosted UI requests one Auth Mini token for every downstream service", () => {
  assert.match(source, /authMiniBaseUrl="https:\/\/auth\.ntnl\.io"/)
  assert.match(source, /AUTH_AUDIENCES = \["cybion\.ntnl\.io", "linkit\.ntnl\.io", "openai\.ntnl\.io"\]/)
  assert.match(source, /audiences=\{AUTH_AUDIENCES\}/)
  assert.doesNotMatch(source, /audience="cybion\.ntnl\.io"/)
  assert.match(source, /autoRedirectToLogin/)
})

test("threads are the only conversation hierarchy", () => {
  assert.match(source, /HashRouter/)
  assert.match(source, /path="\/threads"/)
  assert.match(source, /path="\/threads\/:threadId"/)
  assert.match(source, /\/api\/threads/)
  assert.doesNotMatch(source, /subthread/i)
  assert.doesNotMatch(source, /main_thread/i)
  assert.doesNotMatch(source, /GoalState/)
})

test("new thread preparation waits for the first message before creating a thread", () => {
  assert.match(source, /path="\/threads" element=\{<NewThreadPage/)
  assert.match(source, /function NewThreadPage\(/)
  assert.match(source, /\/api\/threads\/start/)
  assert.match(source, /newThreadPrompt/)
})

test("contexts are managed through a progressive disclosure tree", () => {
  assert.match(source, /path="\/contexts" element=\{<ContextsPage/)
  assert.match(source, /\/api\/contexts/)
  assert.match(source, /<ul role="tree"/)
  assert.match(source, /parent_id/)
  assert.match(source, /contextContent/)
})

test("every thread renders through the shared chat primitives", () => {
  assert.match(source, /<MessageScrollerProvider autoScroll defaultScrollPosition="end">/)
  assert.match(source, /<MessageScrollerViewport>/)
  assert.match(source, /<MessageScrollerContent/)
  assert.match(source, /<MessageScrollerButton behavior="auto"/)
  assert.match(source, /<Message align="end">/)
  assert.match(source, /record\.kind === "input"/)
  assert.doesNotMatch(source, /record\.(request_input_id|role|content|visible)/)
  assert.doesNotMatch(source, /<MessageAvatar/)
  assert.doesNotMatch(source, /<MessageHeader/)
})

test("history renders reasoning summaries and exposes OpenAI native tools", () => {
  assert.match(source, /recordReasoning: "推理 \(Reasoning\)"/)
  assert.match(source, /function isReasoningRecord\(record: HistoryRecord\)/)
  assert.match(source, /function reasoningSummary\(record: HistoryRecord\)/)
  assert.match(source, /detail: "web_search"/)
  assert.match(source, /detail: "image_generation"/)
})

test("the management surfaces expose integration keys and SQLite-free Worker pairing", () => {
  assert.match(source, /\/api\/api-keys/)
  assert.match(source, /\/api\/workers/)
  assert.match(source, /function workerToml/)
  for (const key of ["controller_url", "user_id", "machine_id", "access_token"]) {
    assert.match(source, new RegExp(`${key} =`))
  }
  assert.doesNotMatch(source, /tenant_id|\/turn|run_id|turn_index/)
})

test("the hosted shell keeps the outer navigation and Linkit account surface", () => {
  for (const group of ["navWork", "navAudit", "navSystem", "navConfiguration"]) {
    assert.match(source, new RegExp(`${group}:`))
  }
  for (const route of ["/reasoning-audit", "/history", "/system", "/configuration"]) {
    assert.match(source, new RegExp(`to: \"${route}\"`))
  }
  assert.match(source, /<LinkitProvider/)
  assert.match(source, /<LinkitMyInfo \/>/)
})

test("the shadcn tooltip context and layered error boundaries protect the shell", () => {
  assert.match(source, /import \{ TooltipProvider \} from "@\/components\/ui\/tooltip"/)
  assert.match(source, /<TooltipProvider delayDuration=\{0\}>/)
  assert.match(source, /import \{ ErrorBoundary, ErrorBoundaryFallback \} from "@\/components\/error-boundary"/)
  assert.match(source, /resetKeys=\{\[location\.pathname\]\}/)
  assert.match(source, /<ErrorBoundary fallback=/)
})
