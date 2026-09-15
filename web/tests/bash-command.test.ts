import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createServer } from "vite"

test("bash commands render Worker names, language, command text and raw details", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { BashCommand } = await server.ssrLoadModule("/src/components/bash-command.tsx")
    const call = { workerId: "worker-1", command: 'pwd\necho "<script>alert(1)</script>"' }
    const render = (language: string, workers: { id: string; label: string }[] | undefined) => renderToStaticMarkup(createElement(BashCommand, {
      language, call, workers, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const html = render(language, [{ id: "worker-2", label: "MBA" }, { id: "worker-1", label: "MacMini" }])
      assert.ok(html.includes(language === "zh" ? "正在调用 MacMini 上的命令" : "Calling a command on MacMini"))
      assert.ok(!html.includes("worker-1"))
      assert.ok(!html.includes("MBA"))
      assert.ok(html.includes('pwd\necho &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;'))
      assert.ok(!html.includes("<script>"))
      assert.match(html, /<time[^>]*>12:34:56<\/time>/)
      assert.ok(html.includes("<details>Raw protocol</details>"))
    }
    for (const workers of [undefined, [], [{ id: "worker-2", label: "MBA" }]]) {
      assert.ok(render("en", workers).includes("Calling a command on worker-1"))
    }
    assert.ok(render("en", [{ id: "worker-1", label: "Renamed Worker" }]).includes("Calling a command on Renamed Worker"))
  } finally {
    await server.close()
  }
})

test("persisted and live protocol messages receive Worker updates through memoization", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.equal(source.match(/<HistoryMessage language=\{language\} record=\{record\} workers=\{workers.data\}/g)?.length, 2)
  assert.match(source, /previous.workers === next.workers/)
  assert.ok(source.indexOf("const bashCall = bashFunctionCall(payload)") < source.indexOf('if (record.kind === "checkpoint" ||'))
  assert.match(source, /<BashCommand[^>]*>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/BashCommand>/)
})
