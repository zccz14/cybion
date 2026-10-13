import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const serverOptions = { server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" } as const

test("the Context editor exposes write, source, and preview modes with an accessible toolbar", async () => {
  const server = await createTestServer(serverOptions)
  try {
    const { MarkdownEditor } = await server.ssrLoadModule("/src/components/markdown-editor.tsx")
    const html = renderToStaticMarkup(
      createElement(MarkdownEditor, { language: "zh", value: "# 标题", onChange: () => {} })
    )
    assert.ok(html.includes('role="toolbar"'))
    assert.ok(html.includes('aria-label="插入块"'))
    assert.ok(html.includes(">编辑<"))
    assert.ok(html.includes(">源码<"))
    assert.ok(html.includes(">预览<"))
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.ok(html.includes('data-mode="write"'))
  } finally {
    await server.close()
  }
})

test("source mode shows the raw Markdown and preview mode renders it instead of the source", async () => {
  const server = await createTestServer(serverOptions)
  try {
    const { MarkdownEditor } = await server.ssrLoadModule("/src/components/markdown-editor.tsx")
    const source = renderToStaticMarkup(
      createElement(MarkdownEditor, { language: "zh", value: "**加粗**", onChange: () => {}, defaultMode: "markdown" })
    )
    assert.ok(source.includes("<textarea"))
    assert.ok(source.includes("**加粗**"))
    const preview = renderToStaticMarkup(
      createElement(MarkdownEditor, { language: "zh", value: "**加粗**", onChange: () => {}, defaultMode: "preview" })
    )
    assert.ok(preview.includes("<strong>加粗</strong>"))
    assert.ok(!preview.includes("**加粗**"))
  } finally {
    await server.close()
  }
})
