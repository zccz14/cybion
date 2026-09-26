import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("markdown links open off-site pages in a new tab and carry an external marker", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { Markdown } = await server.ssrLoadModule("/src/components/markdown.tsx")
    const markdown = "请查阅 [Cybion 文档](https://github.com/zccz14/cybion \"仓库\")。\n\n| 功能 | 说明 |\n| --- | --- |\n| 链接 | 新标签页打开 |"
    const html = renderToStaticMarkup(createElement(Markdown, null, markdown))
    assert.ok(html.includes('href="https://github.com/zccz14/cybion"'))
    assert.ok(html.includes('title="仓库"'))
    assert.ok(html.includes('target="_blank"'))
    assert.ok(html.includes('rel="noopener noreferrer"'))
    assert.match(html, />Cybion 文档<svg[^>]*aria-hidden="true"/)
    assert.ok(html.includes("<table>"))
    assert.ok(!html.includes("[object Object]"))
  } finally {
    await server.close()
  }
})

test("every conversation markdown surface renders links through the shared component", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /react-markdown|ReactMarkdown|remark-gfm|remarkGfm/)
  assert.equal(source.match(/<Markdown>/g)?.length, 2)
})
