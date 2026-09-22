import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("the title row offers generating a title from the full thread context", () => {
  assert.match(
    source,
    /api<Thread>\(sdk, `\/api\/threads\/\$\{encodeURIComponent\(threadId\)\}\/title`, \{ method: "POST" \}\)/,
  )
  assert.match(source, /const generateTitle = useMutation/)
  assert.match(source, /<Button type="button" size="icon-sm" variant="outline" aria-label=\{t\("generateTitle"\)\}/)
  assert.match(source, /generateTitle: "Generate a title from the full conversation"/)
  assert.match(source, /generateTitle: "引用全部上下文生成标题"/)
})

test("a generated title replaces the saved one and refreshes thread views", () => {
  const generate = source.slice(
    source.indexOf("const generateTitle = useMutation"),
    source.indexOf("const settings = useMutation"),
  )
  assert.match(generate, /setEditing\(false\)/)
  assert.match(generate, /invalidateQueries\(\{ queryKey: \["thread", threadId\] \}\)/)
  assert.match(generate, /invalidateQueries\(\{ queryKey: \["threads"\] \}\)/)
  assert.match(
    source,
    /\{generateTitle\.error && <div className="shrink-0 p-3"><RequestError error=\{generateTitle\.error\} onRetry=\{\(\) => generateTitle\.mutate\(\)\} \/><\/div>\}/,
  )
})
