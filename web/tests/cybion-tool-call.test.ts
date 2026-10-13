import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { createTestServer } from "./vite-server.ts"

const renderInRouter = (element: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/"] }, element))

test("cybion tool calls render context and machine details with escaped text in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CybionToolCall } = await server.ssrLoadModule("/src/components/cybion-tool-call.tsx")
    const render = (language: string, call: unknown, workers: { id: string; label: string }[] | undefined) => renderInRouter(createElement(CybionToolCall, {
      language, call, workers, contexts: undefined, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    const updateCall = {
      tool: "cybion_set_ultimate_machine", machineId: "machine-1", name: "磁盘检查", workerId: "worker-1",
      intervalSeconds: 600, enabled: true, command: 'echo "<script>alert(1)</script>"', intent: "确保根分区低于 90%",
    }
    for (const language of ["en", "zh"]) {
      const read = render(language, { tool: "read_context", contextId: "ctx-1" }, undefined)
      assert.ok(read.includes(language === "zh" ? "读取上下文" : "Read context"))
      assert.ok(read.includes("ctx-1"))
      const getMachine = render(language, { tool: "cybion_get_ultimate_machine", machineId: "machine-1" }, undefined)
      assert.ok(getMachine.includes(language === "zh" ? "读取终极机器" : "Read Ultimate Machine"))
      assert.ok(getMachine.includes("machine-1"))
      const list = render(language, { tool: "cybion_list_contexts" }, undefined)
      assert.ok(list.includes(language === "zh" ? "列出上下文" : "List contexts"))
      assert.ok(!list.includes("<pre"))
      const update = render(language, updateCall, [{ id: "worker-1", label: "MacMini" }])
      assert.ok(update.includes(language === "zh" ? "更新终极机器" : "Update Ultimate Machine"))
      assert.ok(update.includes("machine-1"))
      assert.ok(update.includes(language === "zh" ? "名称：磁盘检查" : "Name: 磁盘检查"))
      assert.ok(update.includes(language === "zh" ? "Worker：MacMini" : "Worker: MacMini"))
      assert.ok(update.includes(language === "zh" ? "间隔：600 秒" : "Interval: 600s"))
      assert.ok(update.includes(language === "zh" ? "状态：启用" : "State: Enabled"))
      assert.ok(update.includes("echo &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;"))
      assert.ok(!update.includes("<script>"))
      assert.ok(update.includes(language === "zh" ? "意图：确保根分区低于 90%" : "Intent: 确保根分区低于 90%"))
      assert.ok(update.includes("<details>Raw protocol</details>"))
      const updateWithoutWorkers = render(language, updateCall, undefined)
      assert.ok(updateWithoutWorkers.includes(language === "zh" ? "Worker：worker-1" : "Worker: worker-1"))
      const create = render(language, { tool: "cybion_set_ultimate_machine", machineId: null, name: "磁盘检查", workerId: "worker-1", intervalSeconds: 600, enabled: null, command: "df -h", intent: null }, undefined)
      assert.ok(create.includes(language === "zh" ? "创建终极机器" : "Create Ultimate Machine"))
      assert.ok(create.includes("df -h"))
      assert.ok(!create.includes(language === "zh" ? "状态：" : "State:"))
      assert.match(create, /<time[^>]*>12:34:56<\/time>/)
    }
  } finally {
    await server.close()
  }
})

test("read context calls link to the context page with the title and Use When", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CybionToolCall } = await server.ssrLoadModule("/src/components/cybion-tool-call.tsx")
    const render = (contextId: string, contexts: Map<string, { name: string; description: string }> | undefined) => renderInRouter(createElement(CybionToolCall, {
      language: "zh", call: { tool: "read_context", contextId }, workers: undefined, contexts, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    const contexts = new Map([["ctx-1", { name: "个人简介 <script>alert(1)</script>", description: "了解 CZ 背景时使用 & 引用" }]])
    const resolved = render("ctx-1", contexts)
    assert.ok(resolved.includes("个人简介 &lt;script&gt;alert(1)&lt;/script&gt;"))
    assert.ok(!resolved.includes("<script>"))
    assert.ok(resolved.includes("了解 CZ 背景时使用 &amp; 引用"))
    assert.match(resolved, /<a[^>]*href="\/contexts\?context=ctx-1"[^>]*>/)
    assert.ok(resolved.includes("<details>Raw protocol</details>"))
    assert.ok(!resolved.includes("ctx-1</pre>"))
    assert.equal((resolved.match(/<p /g) ?? []).length, 1)
    const unresolved = render("ctx-2", contexts)
    assert.ok(unresolved.includes("ctx-2</pre>"))
    assert.ok(!unresolved.includes("<a "))
    const encoded = render("a b", new Map([["a b", { name: "Space", description: "" }]]))
    assert.match(encoded, /href="\/contexts\?context=a%20b"/)
    assert.equal((encoded.match(/<p /g) ?? []).length, 0)
  } finally {
    await server.close()
  }
})

test("thread view renders cybion tool calls before the generic protocol renderer", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.ok(source.indexOf("const cybionCall = cybionToolFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<CybionToolCall language=\{language\} call=\{cybionCall\} workers=\{workers\} contexts=\{contexts\} time=\{time\}>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/CybionToolCall>/)
})

test("read context titles resolve through gated context caches", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  for (const needle of [
    "const readsContexts = useMemo",
    'queryKey: ["contexts"]',
    'queryKey: ["common-contexts", language]',
    "contexts={contextLookup} />",
    "contexts={undefined} />",
    "previous.contexts === next.contexts",
  ]) {
    assert.ok(source.includes(needle), needle)
  }
  assert.equal(source.match(/enabled: readsContexts/g)?.length, 2)
})
