import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createServer } from "vite"

test("process groups are native closed disclosures with bilingual counts, elapsed time and original children", async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { ThreadProcessGroup } = await server.ssrLoadModule("/src/components/thread-process-group.tsx")
    for (const language of ["zh", "en"]) {
      const html = renderToStaticMarkup(createElement(ThreadProcessGroup, {
        language, count: 8, durationSeconds: 135, children: createElement("pre", null, "Original <payload>"),
      }))
      assert.match(html, /^<details[^>]*data-slot="thread-process-group"/)
      assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/)
      assert.match(html, /<summary/)
      assert.match(html, /aria-hidden="true"/)
      assert.ok(html.includes(language === "zh" ? "过程消息" : "Process messages"))
      assert.ok(html.includes(language === "zh" ? "8 条" : "8 messages"))
      assert.ok(html.includes(language === "zh" ? "运行了 00 小时 02 分钟 15 秒" : "Ran for 00h 02m 15s"))
      assert.ok(html.includes("<pre>Original &lt;payload&gt;</pre>"))
    }
    const singleton = renderToStaticMarkup(createElement(ThreadProcessGroup, { language: "en", count: 1, durationSeconds: 0 }))
    assert.match(singleton, />1 message</)
    assert.ok(singleton.includes("Ran for 00h 00m 00s"))
  } finally {
    await server.close()
  }
})
