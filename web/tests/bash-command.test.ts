import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const now = Math.floor(Date.now() / 1000)

test("bash commands render Worker names, language, command text and raw details", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { BashCommand } = await server.ssrLoadModule("/src/components/bash-command.tsx")
    const call = { callId: "call-1", workerId: "worker-1", summary: "检查 <script>alert(1)</script> 工作区", command: 'pwd\necho "<script>alert(1)</script>"', delaySeconds: null, timeoutSeconds: null }
    const render = (language: string, workers: { id: string; label: string }[] | undefined) => renderToStaticMarkup(createElement(BashCommand, {
      language, call, workers, time: "12:34:56", startedAt: now, inFlight: false, children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const html = render(language, [{ id: "worker-2", label: "MBA" }, { id: "worker-1", label: "MacMini" }])
      assert.ok(html.includes(language === "zh" ? "正在调用 MacMini 上的命令" : "Calling a command on MacMini"))
      assert.ok(!html.includes("worker-1"))
      assert.ok(!html.includes("MBA"))
      assert.ok(html.includes("检查 &lt;script&gt;alert(1)&lt;/script&gt; 工作区"))
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

test("a call in flight counts the controller delay down and then the Worker timeout", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { BashCommand } = await server.ssrLoadModule("/src/components/bash-command.tsx")
    const call = (delaySeconds: number | null, timeoutSeconds: number | null) => ({ callId: "call-1", workerId: "worker-1", summary: null, command: "pwd", delaySeconds, timeoutSeconds })
    // The countdown reads the browser clock, so each case is anchored far enough from
    // a phase boundary that the second it renders in cannot change the phase.
    const render = (language: string, startedAt: number, inFlight: boolean, schedule: ReturnType<typeof call>) => renderToStaticMarkup(createElement(BashCommand, {
      language, call: schedule, workers: [{ id: "worker-1", label: "MacMini" }], time: "12:34:56", startedAt, inFlight, children: null,
    }))
    const countdown = (html: string) => html.match(/<p data-slot="bash-countdown"[^>]*>([^<]*)<\/p>/)

    const delayed = countdown(render("zh", now, true, call(3600, 300)))
    assert.equal(delayed?.[0].includes('data-phase="delayed"'), true)
    assert.ok(delayed?.[1].startsWith("延迟等待中 · 还剩 "))

    const running = countdown(render("zh", now - 3600, true, call(null, 7200)))
    assert.equal(running?.[0].includes('data-phase="running"'), true)
    assert.ok(running?.[1].startsWith("执行中 · 超时还剩 "))

    // A call that names no timeout counts against the tool's documented default.
    const defaulted = countdown(render("en", now - 60, true, call(null, null)))
    assert.equal(defaulted?.[0].includes('data-phase="running"'), true)
    assert.ok(defaulted?.[1].startsWith("Running · "))

    const expired = countdown(render("zh", now - 3600, true, call(null, null)))
    assert.equal(expired?.[0].includes('data-phase="expired"'), true)
    assert.equal(expired?.[1], "已过超时 · 正在取消")

    // A settled call shows no countdown: its deadline has already passed.
    assert.equal(countdown(render("zh", now, false, call(3600, 300))), null)
  } finally {
    await server.close()
  }
})

test("persisted and live protocol messages receive Worker updates through memoization", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.equal(source.match(/<HistoryMessage language=\{language\} record=\{record\} workers=\{workers.data\}/g)?.length, 1)
  assert.match(source, /<ThreadHistory records=\{records\}/)
  assert.match(source, /pendingResponseRecords\(liveResponse.data, durableRecords, threadId\)/)
  assert.match(source, /previous.workers === next.workers/)
  assert.match(source, /inFlightCallIds\(running \? durableRecords : \[\]\)/)
  assert.match(source, /inFlight=\{recordInFlight\(record, inFlightCalls\)\}/)
  assert.ok(source.indexOf("const bashCall = bashFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<BashCommand[^>]*>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/BashCommand>/)
})
