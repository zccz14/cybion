import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readPackageSource } from "./package-source.ts"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("the title row offers generating a title from the full thread manual", () => {
  const api = readPackageSource("api.ts")
  const view = readPackageSource("thread-view.tsx")
  const copy = readPackageSource("copy.ts")
  assert.match(api, /return this\.request<Thread>\(`\/api\/threads\/\$\{encodeURIComponent\(id\)\}\/title`, \{ method: "POST" \}\)/)
  assert.match(view, /const generateTitle = useMutation/)
  assert.match(view, /<Button type="button" size="icon-sm" variant="outline" aria-label=\{t\("generateTitle"\)\}/)
  assert.match(copy, /generateTitle: \{ en: "Generate a title from the full conversation"/)
  assert.match(copy, /zh: "引用全部重放内容生成标题"/)
})

test("a generated title replaces the saved one and refreshes thread views", () => {
  const view = readPackageSource("thread-view.tsx")
  const generate = view.slice(view.indexOf("const generateTitle = useMutation"), view.indexOf("const settings = useMutation"))
  assert.match(generate, /setTitle\(thread\.title\)/)
  assert.match(generate, /setEditing\(false\)/)
  // The host mirrors the stored title, so every other view of this Thread follows it.
  assert.match(view, /onTitleChange\?\.\(thread\.data\.title\)/)
  assert.match(view, /onThreadChange\?\.\(thread\.data\)/)
})
