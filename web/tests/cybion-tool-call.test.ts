import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("cybion tool calls render context and machine details with escaped text in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CybionToolCall } = await server.ssrLoadModule("/src/components/cybion-tool-call.tsx")
    const render = (language: string, call: unknown, workers: { id: string; label: string }[] | undefined) => renderToStaticMarkup(createElement(CybionToolCall, {
      language, call, workers, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
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

test("thread view renders cybion tool calls before the generic protocol renderer", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.ok(source.indexOf("const cybionCall = cybionToolFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<CybionToolCall language=\{language\} call=\{cybionCall\} workers=\{workers\} time=\{time\}>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/CybionToolCall>/)
})
