import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("assistant messages render flat Markdown without an avatar, name, or bubble and keep a footer below", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { AssistantMessage } = await server.ssrLoadModule("/src/components/assistant-message.tsx")
    const html = renderToStaticMarkup(createElement(AssistantMessage, { language: "zh", text: "## 部署状态\n\n- **检查通过**：服务健康。", time: "12:34:56" }))
    assert.ok(html.includes('data-slot="assistant-message"'))
    assert.ok(html.includes("<h2>部署状态</h2>"))
    assert.ok(html.includes("<strong>检查通过</strong>"))
    assert.ok(!html.includes("Cybion"))
    assert.ok(!html.includes("lucide-sparkles"))
    assert.ok(html.includes('data-slot="assistant-footer"'))
    assert.ok(html.includes(">12:34:56<"))
    assert.ok(html.indexOf('data-slot="assistant-content"') < html.indexOf('data-slot="assistant-footer"'))
  } finally {
    await server.close()
  }
})
