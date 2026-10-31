import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Every Markdown surface in the app, in the order they appear in the transcript.
const surfaces = [
  "../src/main.tsx",
  "../src/components/assistant-message.tsx",
  "../src/components/checkpoint-message.tsx",
  "../src/components/markdown-editor.tsx",
]
const sources = surfaces.map((surface) => readFileSync(new URL(surface, import.meta.url), "utf8"))

test("every Markdown surface renders through the shared renderer", () => {
  for (const source of sources) assert.match(source, /from "@zccz14\/ux"/)
  // 排版在库里的 .ux-markdown：应用只决定字号与栏宽，不再自带 prose 调色板。
  for (const source of sources) assert.doesNotMatch(source, /\bprose\b/)
  // 渲染管线只存在于库里，应用不得直接依赖任何一环。
  for (const source of sources) {
    assert.doesNotMatch(source, /react-markdown|ReactMarkdown|remark-gfm|remarkGfm|rehype-katex|katex/)
  }
  assert.equal(sources[0].match(/<Markdown content=/g)?.length, 2)
  assert.equal(sources[1].match(/<Markdown content=/g)?.length, 1)
  assert.equal(sources[2].match(/<Markdown content=/g)?.length, 1)
  assert.equal(sources[3].match(/<MarkdownPreview content=/g)?.length, 1)
})

test("the app ships neither its own renderer nor the KaTeX stylesheet", () => {
  assert.throws(() => readFileSync(new URL("../src/components/markdown.tsx", import.meta.url)))
  assert.throws(() => readFileSync(new URL("../src/components/mermaid.tsx", import.meta.url)))
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")
  assert.doesNotMatch(styles, /@tailwindcss\/typography/)
  assert.doesNotMatch(styles, /katex/)
})
