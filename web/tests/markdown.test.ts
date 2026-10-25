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
  const surfaces = ["../src/main.tsx", "../src/components/assistant-message.tsx", "../src/components/checkpoint-message.tsx", "../src/components/markdown-editor.tsx"]
  const sources = surfaces.map((surface) => readFileSync(new URL(surface, import.meta.url), "utf8"))
  for (const source of sources) assert.doesNotMatch(source, /react-markdown|ReactMarkdown|remark-gfm|remarkGfm/)
  assert.equal(sources[0].match(/<Markdown>/g)?.length, 2)
  assert.equal(sources[1].match(/<Markdown>/g)?.length, 1)
  assert.equal(sources[2].match(/<Markdown>/g)?.length, 1)
  assert.equal(sources[3].match(/<MarkdownPreview>/g)?.length, 1)
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

test("math renders through KaTeX for inline, display, fenced, and broken input", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { Markdown } = await server.ssrLoadModule("/src/components/markdown.tsx")
    const render = (markdown: string) => renderToStaticMarkup(createElement(Markdown, null, markdown))
    const inline = render("质能方程 $E=mc^2$ 把质量与能量联系起来。")
    assert.match(inline, /<span class="katex">/)
    assert.ok(inline.includes('<span class="katex-mathml">'))
    assert.ok(inline.includes('class="katex-html" aria-hidden="true"'))
    assert.ok(inline.includes("质能方程"))
    const display = render("求和公式：\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n")
    assert.match(display, /class="katex-display"/)
    assert.ok(display.includes("katex-mathml"))
    const fenced = render("```math\na^2 + b^2 = c^2\n```\n\n```ts\nconst answer = 42\n```\n")
    assert.match(fenced, /class="katex-display"/)
    assert.match(fenced, /<pre><code class="language-ts">const answer = 42/)
    const broken = render("坏掉的公式 $\\frac{$ 不应打断渲染")
    assert.match(broken, /<span class="katex-error" title="/)
    assert.ok(broken.includes('style="color:var(--destructive)"'))
    assert.ok(broken.includes("不应打断渲染"))
  } finally {
    await server.close()
  }
})

test("the shared markdown renderer wires math and KaTeX styles once for every surface", () => {
  const markdown = readFileSync(new URL("../src/components/markdown.tsx", import.meta.url), "utf8")
  assert.match(markdown, /from "remark-math-extended"/)
  assert.match(markdown, /from "rehype-katex"/)
  assert.match(markdown, /import "katex\/dist\/katex\.min\.css"/)
  assert.equal(markdown.match(/remarkPlugins=/g)?.length, 1)
  assert.equal(markdown.match(/rehypePlugins=/g)?.length, 1)
})

test("LaTeX backslash delimiters render as math and leave the rest of Markdown alone", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { Markdown } = await server.ssrLoadModule("/src/components/markdown.tsx")
    const render = (markdown: string) => renderToStaticMarkup(createElement(Markdown, null, markdown))
    // 模型实际吐出的形态：展示公式用 \[...\]，行内公式用 \(...\)。
    const display = render("可以先检验状态依赖的概率收缩：\n\n\\[ p=\\sigma\\left(\\frac{\\operatorname{logit}(\\mu)}{T(s)}\\right) \\]\n")
    assert.match(display, /class="katex-display"/)
    assert.ok(display.includes("katex-mathml"))
    assert.ok(display.includes("可以先检验状态依赖的概率收缩："))
    assert.doesNotMatch(display, /katex-error/)
    const inline = render("其中 \\(\\alpha+\\beta\\) 是两个系数。")
    assert.match(inline, /<span class="katex">/)
    assert.ok(inline.includes("是两个系数"))
    // 其余 Markdown 语义不变：反斜杠转义、围栏代码与行内代码都不进公式。
    const escapes = render("路径 \\*不是斜体\\* 与 \\_下划线\\_。")
    assert.ok(escapes.includes("*不是斜体*"))
    assert.ok(escapes.includes("_下划线_"))
    assert.doesNotMatch(escapes, /katex/)
    const fence = render("```ts\nconst x = \\[ a \\]\n```\n\n行内 \\(y\\) 写成 `\\[ z \\]`。")
    assert.ok(fence.includes('<code class="language-ts">const x = \\[ a \\]'))
    assert.ok(fence.includes("<code>\\[ z \\]</code>"))
    assert.match(fence, /<span class="katex">/)
    // 公式里的 \\[2pt] 是换行命令，不是新的展示公式：必须仍是同一个公式且不报错。
    const aligned = render("$$\n\\begin{aligned}\na &= b \\\\[2pt]\nc &= d\n\\end{aligned}\n$$")
    assert.equal((aligned.match(/class="katex-display"/g) ?? []).length, 1)
    assert.ok(aligned.includes("katex-mathml"))
    assert.doesNotMatch(aligned, /katex-error/)
    // 流式输出未闭合时保持原文，不闪成半个公式。
    const partial = render("还在输出：\\[ p=\\sigma")
    assert.doesNotMatch(partial, /katex/)
    assert.ok(partial.includes("[ p=\\sigma"))
  } finally {
    await server.close()
  }
})
