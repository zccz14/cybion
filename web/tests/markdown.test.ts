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
  const surfaces = ["../src/main.tsx", "../src/components/assistant-message.tsx", "../src/components/checkpoint-message.tsx"]
  const sources = surfaces.map((surface) => readFileSync(new URL(surface, import.meta.url), "utf8"))
  for (const source of sources) assert.doesNotMatch(source, /react-markdown|ReactMarkdown|remark-gfm|remarkGfm/)
  assert.equal(sources[0].match(/<Markdown>/g)?.length, 1)
  assert.equal(sources[1].match(/<Markdown>/g)?.length, 1)
  assert.equal(sources[2].match(/<Markdown>/g)?.length, 1)
})

test("mermaid fenced blocks render through the shared Mermaid component", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { Markdown } = await server.ssrLoadModule("/src/components/markdown.tsx")
    const markdown = "```mermaid\ngraph TD\n  A --> B\n```\n\n```ts\nconst answer = 42\n```\n\n行内 `mermaid` 代码"
    const html = renderToStaticMarkup(createElement(Markdown, null, markdown))
    // 服务端渲染只输出源码形态，浏览器渲染后再替换为 SVG 图表
    assert.match(html, /<pre data-mermaid="source"[^>]*><code class="language-mermaid">graph TD/)
    assert.ok(!html.includes('data-mermaid="diagram"'))
    assert.match(html, /<pre><code class="language-ts">const answer = 42/)
    assert.ok(html.includes("<code>mermaid</code>"))
  } finally {
    await server.close()
  }
})

test("mermaid rendering stays lazily loaded through the shared markdown renderer", () => {
  const mermaid = readFileSync(new URL("../src/components/mermaid.tsx", import.meta.url), "utf8")
  assert.match(mermaid, /await import\("mermaid"\)/)
  assert.doesNotMatch(mermaid, /from "mermaid"/)
  const markdown = readFileSync(new URL("../src/components/markdown.tsx", import.meta.url), "utf8")
  assert.match(markdown, /from "@\/components\/mermaid"/)
  assert.doesNotMatch(markdown, /from "mermaid"/)
})
