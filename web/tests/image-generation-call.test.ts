import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"
import { readPackageSource } from "./package-source.ts"

test("image generation calls render the prompt and reference positions in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { ImageGenerationCall } = await server.ssrLoadModule("@zccz14/cybion-components")
    const render = (language: string, referenceImages: number[]) => renderToStaticMarkup(createElement(ImageGenerationCall, {
      language, call: { prompt: "柴犬 <script>alert(1)</script>", referenceImages }, time: "12:34:56",
      children: createElement("details", null, "Raw protocol"),
    }))
    for (const language of ["en", "zh"]) {
      const html = render(language, [1, 3])
      assert.ok(html.includes(language === "zh" ? "图像生成" : "Image generation"))
      assert.ok(html.includes("柴犬 &lt;script&gt;alert(1)&lt;/script&gt;"))
      assert.ok(!html.includes("<script>"))
      assert.ok(html.includes(language === "zh" ? "参考图片：#1、#3" : "Reference images: #1, #3"))
      assert.match(html, /<time[^>]*>12:34:56<\/time>/)
      assert.ok(html.includes("<details>Raw protocol</details>"))
      const textOnly = render(language, [])
      assert.ok(!textOnly.includes("#1"))
      assert.ok(!textOnly.includes(language === "zh" ? "参考图片" : "Reference images"))
    }
  } finally {
    await server.close()
  }
})

test("thread view renders image generation calls before the generic protocol renderer", () => {
  const source = readPackageSource("components/history-message.tsx")
  assert.ok(source.indexOf("const imageCall = imageGenerationFunctionCall(payload)") < source.indexOf('if (typeof payload?.type === "string" &&'))
  assert.match(source, /<ImageGenerationCall[^>]*>[\s\S]*?<PayloadDetails language=\{language\} record=\{record\} label=\{t\("recordPayload"\)\} \/>[\s\S]*?<\/ImageGenerationCall>/)
})
