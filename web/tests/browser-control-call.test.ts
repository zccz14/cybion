import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("browser control calls render action details with escaped text in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { BrowserControlCall } = await server.ssrLoadModule("/src/components/browser-control-call.tsx")
    const render = (language: string, call: unknown) => renderToStaticMarkup(createElement(BrowserControlCall, {
      language, call, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const navigate = render(language, { action: "navigate", url: "https://example.com/<script>alert(1)</script>" })
      assert.ok(navigate.includes(language === "zh" ? "打开网页" : "Open page"))
      assert.ok(navigate.includes("https://example.com/&lt;script&gt;alert(1)&lt;/script&gt;"))
      assert.ok(!navigate.includes("<script>"))
      const typed = render(language, { action: "type", selector: "#query", text: "你好 & <b>world</b>" })
      assert.ok(typed.includes(language === "zh" ? "输入文本" : "Type text"))
      assert.ok(typed.includes("你好 &amp; &lt;b&gt;world&lt;/b&gt;"))
      assert.ok(typed.includes("#query"))
      assert.ok(typed.includes(language === "zh" ? "选择器：" : "Selector: "))
      assert.ok(!typed.includes("<b>"))
      const evaluate = render(language, { action: "evaluate", text: "document.title" })
      assert.ok(evaluate.includes(language === "zh" ? "执行脚本" : "Evaluate script"))
      assert.ok(evaluate.includes("document.title"))
      const screenshot = render(language, { action: "screenshot" })
      assert.ok(screenshot.includes(language === "zh" ? "截取屏幕截图" : "Capture a screenshot"))
      assert.match(screenshot, /<time[^>]*>12:34:56<\/time>/)
      assert.ok(screenshot.includes("<details>Raw protocol</details>"))
    }
  } finally {
    await server.close()
  }
})

test("thread view renders browser control calls before the generic protocol renderer", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.ok(source.indexOf("const browserCall = browserControlFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<BrowserControlCall[^>]*>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/BrowserControlCall>/)
})
