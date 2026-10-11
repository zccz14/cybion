import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("web search calls render the query with escaped text in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { WebSearchCall } = await server.ssrLoadModule("/src/components/web-search-call.tsx")
    const call = { query: "最新版 Rust 发布了吗 <script>alert(1)</script>" }
    const render = (language: string) => renderToStaticMarkup(createElement(WebSearchCall, {
      language, call, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const html = render(language)
      assert.ok(html.includes(language === "zh" ? "网页搜索" : "Web search"))
      assert.ok(html.includes("最新版 Rust 发布了吗 &lt;script&gt;alert(1)&lt;/script&gt;"))
      assert.ok(!html.includes("<script>"))
      assert.match(html, /<time[^>]*>12:34:56<\/time>/)
      assert.ok(html.includes("<details>Raw protocol</details>"))
    }
  } finally {
    await server.close()
  }
})

test("thread view renders web search calls before the generic protocol renderer", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.ok(source.indexOf("const searchCall = webSearchFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<WebSearchCall[^>]*>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/WebSearchCall>/)
})
