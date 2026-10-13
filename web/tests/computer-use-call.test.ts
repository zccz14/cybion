import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("desktop control calls render action details with escaped text in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { ComputerUseCall } = await server.ssrLoadModule("/src/components/computer-use-call.tsx")
    const render = (language: string, call: unknown) => renderToStaticMarkup(createElement(ComputerUseCall, {
      language, call, time: "12:34:56", children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const move = render(language, { action: "move", x: 100, y: 200 })
      assert.ok(move.includes(language === "zh" ? "移动鼠标到 (100, 200)" : "Move the pointer to (100, 200)"))
      const click = render(language, { action: "click", x: 30, y: 40 })
      assert.ok(click.includes(language === "zh" ? "点击 (30, 40)" : "Click at (30, 40)"))
      const typed = render(language, { action: "type", text: "你好 & <b>world</b>" })
      assert.ok(typed.includes(language === "zh" ? "输入文本" : "Type text"))
      assert.ok(typed.includes("你好 &amp; &lt;b&gt;world&lt;/b&gt;"))
      assert.ok(!typed.includes("<b>"))
      const screenshot = render(language, { action: "screenshot" })
      assert.ok(screenshot.includes(language === "zh" ? "截取屏幕截图" : "Capture a screenshot"))
      assert.match(screenshot, /<time[^>]*>12:34:56<\/time>/)
      assert.ok(screenshot.includes("<details>Raw protocol</details>"))
    }
  } finally {
    await server.close()
  }
})

test("thread view renders desktop control calls before the generic protocol renderer", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.ok(source.indexOf("const computerCall = computerUseFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<ComputerUseCall[^>]*>[\s\S]*?<HistoryRecordPayload language=\{language\} record=\{record\} \/>[\s\S]*?<\/ComputerUseCall>/)
})
