import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const checkpoint = `# Durable working manual

## 概念与术语

- **Checkpoint**：把手册压缩成 Markdown 的持久记录。

## 当前目标与下一步

继续验证 checkpoint 的渲染效果。

\`\`\`json
[{"topic_key":"checkpoint-rendering","status":"open"}]
\`\`\`
`

test("checkpoint cards stay in the conversation with their body folded behind the summary", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CheckpointMessage } = await server.ssrLoadModule("/src/components/checkpoint-message.tsx")
    const record = { id: 6, thread_id: "thread-a", kind: "checkpoint", payload: { role: "developer", content: checkpoint }, created_at: 1_800_003_681 }
    const render = (language: string) => renderToStaticMarkup(createElement(CheckpointMessage, { language, record }))
    const zh = render("zh")
    // The card is a <details> the reader did not open, so the compression point shows as a
    // single summary line and the Markdown it carries stays behind one deliberate step.
    const card = /<details data-slot="checkpoint-message"[^>]*>/.exec(zh)?.[0]
    assert.ok(card !== undefined)
    assert.doesNotMatch(card, /\bopen\b/)
    assert.ok(zh.indexOf("checkpoint-preview") < zh.indexOf("</summary>"))
    assert.ok(zh.indexOf("checkpoint-content") > zh.indexOf("</summary>"))
    assert.ok(zh.includes(">上下文检查点<"))
    assert.ok(zh.includes(">内部记录<"))
    assert.ok(zh.includes(">Checkpoint：把手册压缩成 Markdown 的持久记录。<"))
    assert.ok(zh.includes(">查看原始负载<"))
    assert.ok(zh.includes("#6"))
    assert.ok(zh.includes("&quot;role&quot;: &quot;developer&quot;"))
    // The full Markdown is not truncated: every heading, list item and code block is intact.
    assert.ok(zh.includes("<h1>Durable working manual</h1>"))
    assert.ok(zh.includes("<h2>概念与术语</h2>"))
    assert.ok(zh.includes("<li>"))
    assert.ok(zh.includes("<pre>") && zh.includes("checkpoint-rendering"))
    const en = render("en")
    assert.ok(en.includes(">Checkpoint<"))
    assert.ok(en.includes(">Internal<"))
    assert.ok(en.includes(">View raw payload<"))
  } finally {
    await server.close()
  }
})

test("a checkpoint without a prose line previews the hint while its body still carries the Markdown", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CheckpointMessage } = await server.ssrLoadModule("/src/components/checkpoint-message.tsx")
    const record = { id: 7, thread_id: "thread-a", kind: "checkpoint", payload: { role: "developer", content: "# Durable working manual\n\n```json\n[]\n```\n" }, created_at: 1_800_003_681 }
    const render = (language: string) => renderToStaticMarkup(createElement(CheckpointMessage, { language, record }))
    assert.ok(render("zh").includes(">上下文已压缩为 Markdown，点开可读<"))
    assert.ok(render("en").includes(">Manual compressed into Markdown — open to read it<"))
    assert.ok(render("zh").includes("<h1>Durable working manual</h1>"))
  } finally {
    await server.close()
  }
})
