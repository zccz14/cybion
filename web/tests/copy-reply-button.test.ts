import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("the reply copy button labels itself in both languages and owns a status line", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CopyReplyButton } = await server.ssrLoadModule("/src/components/copy-reply-button.tsx")
    const zh = renderToStaticMarkup(createElement(CopyReplyButton, { text: "回复内容", language: "zh" }))
    assert.match(zh, /<button[^>]*type="button"/)
    assert.ok(zh.includes('aria-label="复制"'))
    assert.ok(zh.includes('title="复制"'))
    assert.ok(zh.includes('role="status"'))
    const en = renderToStaticMarkup(createElement(CopyReplyButton, { text: "reply", language: "en" }))
    assert.ok(en.includes('aria-label="Copy"'))
  } finally {
    await server.close()
  }
})

test("assistant replies render the copy button directly beneath the reply content", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(source, /import \{ CopyReplyButton \} from "@\/components\/copy-reply-button"/)
  assert.equal(source.match(/<CopyReplyButton text=\{text\} language=\{language\} \/>/g)?.length, 1)
  const replyIndex = source.indexOf("<Markdown>{text}</Markdown>")
  const buttonIndex = source.indexOf("<CopyReplyButton")
  assert.ok(replyIndex >= 0 && buttonIndex > replyIndex)
  assert.ok(buttonIndex < source.indexOf('if (record.kind === "tool_output")'))
})
