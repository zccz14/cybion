import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"

// The Manual is a stored document a Thread reads on demand. The context window is
// not a Manual: it is what replay occupies in one request. A blanket rename once
// shipped "手册 371.8K / 400K" in the thread header and "Manual budget" in the
// settings page, so the window sense keeps its own words and these pairs are
// banned from the console source.
const banned = [
  "手册压缩",
  "对话手册",
  "手册预算",
  "手册窗口",
  "手册占用",
  "Manual budget",
  "Manual compaction",
  "Manual window",
  "Manual usage",
]

function sources(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
    if (entry.isDirectory()) return sources(child)
    return /\.tsx?$/.test(entry.name) ? [readFileSync(child, "utf8")] : []
  })
}

test("window-sense copy never calls the context window a Manual", () => {
  const offenders = sources(new URL("../src/", import.meta.url)).flatMap((text) =>
    banned.filter((phrase) => text.includes(phrase)),
  )
  assert.deepEqual(offenders, [])
})

test("the thread header names the context window, not a Manual", () => {
  const chip = readFileSync(new URL("../src/components/thread-usage.tsx", import.meta.url), "utf8")
  assert.match(chip, /context: "上下文"/)
  assert.match(chip, /context: "Context"/)
  assert.doesNotMatch(chip, /manual: "手册"/)
  assert.doesNotMatch(chip, /manual: "Manual"/)
})
