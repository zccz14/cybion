import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("user inputs render their text with the shared copy control and skip it without text", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { UserInputMessage } = await server.ssrLoadModule("/src/components/user-input-message.tsx")
    const render = (language: string, content: string) => renderToStaticMarkup(createElement(UserInputMessage, { language, payload: { role: "user", content } }))
    const zh = render("zh", "看看这张图。")
    assert.ok(zh.includes("看看这张图。"))
    assert.ok(zh.includes('aria-label="复制"'))
    const en = render("en", "check the image")
    assert.ok(en.includes('aria-label="Copy"'))
    const empty = render("zh", "")
    assert.ok(!empty.includes('aria-label="复制"'))
  } finally {
    await server.close()
  }
})
