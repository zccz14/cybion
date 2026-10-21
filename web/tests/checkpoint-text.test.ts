import assert from "node:assert/strict"
import test from "node:test"
import { checkpointPreview } from "../src/lib/checkpoint-text.ts"

test("preview skips headings, rules, quotes and table rows to reach the first prose line", () => {
  const markdown = "# Durable working manual\n\n---\n\n> quoted\n\n| a | b |\n| - | - |\n\n## 概念与术语\n\n- **Thread**：独立的对话与执行单元。\n"
  assert.equal(checkpointPreview(markdown), "Thread：独立的对话与执行单元。")
  assert.equal(checkpointPreview("1. Deploy the Worker\n2. Verify\n"), "Deploy the Worker")
  assert.equal(checkpointPreview("Plain paragraph with `code`.\n"), "Plain paragraph with code.")
})

test("the first fenced block ends the search, so evidence never becomes the preview", () => {
  assert.equal(checkpointPreview("# Durable working manual\n\n```json\n[{\"topic_key\":\"a\"}]\n```\n"), "")
  assert.equal(checkpointPreview("# Durable working manual\n\n- one fact\n\n```json\n[]\n```\n"), "one fact")
  assert.equal(checkpointPreview(""), "")
  assert.equal(checkpointPreview("# Durable working manual\n\n## 当前目标\n"), "")
})

test("a long prose line is truncated to one readable line", () => {
  const preview = checkpointPreview(`${"字".repeat(200)}\n`)
  assert.equal(preview.length, 120)
  assert.ok(preview.endsWith("…"))
})
