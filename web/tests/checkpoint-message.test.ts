import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const checkpoint = `# Durable working context

## 概念与术语

- **Checkpoint**：把上下文压缩成 Markdown 的持久记录。

## 当前目标与下一步

继续验证 checkpoint 的渲染效果。

\`\`\`json
[{"topic_key":"checkpoint-rendering","status":"open"}]
\`\`\`
`

test("checkpoint records render their Markdown content with label, badge and raw payload", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CheckpointMessage } = await server.ssrLoadModule("/src/components/checkpoint-message.tsx")
    const record = { id: 6, thread_id: "thread-a", kind: "checkpoint", payload: { role: "developer", content: checkpoint }, created_at: 1_800_003_681 }
    const render = (language: string) => renderToStaticMarkup(createElement(CheckpointMessage, { language, record }))
    const zh = render("zh")
    assert.ok(zh.includes('data-slot="checkpoint-content"'))
    assert.ok(zh.includes(">上下文检查点<"))
    assert.ok(zh.includes(">内部记录<"))
    assert.ok(zh.includes(">查看原始负载<"))
    assert.ok(zh.includes("<h1>Durable working context</h1>"))
    assert.ok(zh.includes("<h2>概念与术语</h2>"))
    assert.ok(zh.includes("<li>"))
    assert.ok(zh.includes("<pre>") && zh.includes("checkpoint-rendering"))
    assert.ok(zh.includes("#6"))
    assert.ok(zh.includes("&quot;role&quot;: &quot;developer&quot;"))
    const en = render("en")
    assert.ok(en.includes(">Checkpoint<"))
    assert.ok(en.includes(">Internal<"))
    assert.ok(en.includes(">View raw payload<"))
  } finally {
    await server.close()
  }
})

test("checkpoint rows render full Markdown content instead of a truncated summary", () => {
  const source = readFileSync(new URL("../src/components/checkpoint-message.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /historyRecordSummary|historyRecordLabel/)
})
