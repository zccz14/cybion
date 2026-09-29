import assert from "node:assert/strict"
import test from "node:test"

import { defaultThreadListFilters, hasThreadListFilters, threadListUrl } from "../src/lib/thread-search.ts"

test("the default view lists every active thread", () => {
  assert.equal(threadListUrl(defaultThreadListFilters), "/api/threads")
  assert.equal(hasThreadListFilters(defaultThreadListFilters), false)
})

test("view chips map to the origin and status parameters", () => {
  assert.equal(threadListUrl({ view: "mine", q: "" }), "/api/threads?origin=web")
  assert.equal(threadListUrl({ view: "api", q: "" }), "/api/threads?origin=api")
  assert.equal(threadListUrl({ view: "running", q: "" }), "/api/threads?status=running")
  assert.equal(threadListUrl({ view: "failed", q: "" }), "/api/threads?status=failed")
})

test("search text is trimmed, encoded, and combined with the view", () => {
  assert.equal(threadListUrl({ view: "api", q: "  room/1  " }), "/api/threads?origin=api&q=room%2F1")
  assert.equal(threadListUrl({ view: "all", q: "   " }), "/api/threads")
  assert.equal(hasThreadListFilters({ view: "all", q: "  " }), false)
  assert.equal(hasThreadListFilters({ view: "failed", q: "" }), true)
  assert.equal(hasThreadListFilters({ view: "all", q: "bridge" }), true)
})
