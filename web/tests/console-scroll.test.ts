import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("the console follows streaming changes while its bottom remains visible", () => {
  assert.match(
    source,
    /<MessageScrollerProvider autoScroll defaultScrollPosition="end">/,
  )
})

test("the console keeps the message scroller's bottom-follow and user-scroll boundary", () => {
  assert.match(source, /<MessageScrollerViewport>/)
  assert.match(source, /<MessageScrollerContent/)
  assert.match(source, /<MessageScrollerButton behavior="auto"/)
})
