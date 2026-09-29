import assert from "node:assert/strict"
import test from "node:test"

import { defaultThreadListFilters, hasThreadListFilters, mergeThreadPages, threadListUrl } from "../src/lib/thread-search.ts"

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

test("cursors and the archived scope append to the query", () => {
  assert.equal(threadListUrl({ view: "all", q: "" }, "123:0c4d"), "/api/threads?cursor=123%3A0c4d")
  assert.equal(threadListUrl({ view: "api", q: "room" }, "456:9f2e"), "/api/threads?origin=api&q=room&cursor=456%3A9f2e")
  assert.equal(threadListUrl(defaultThreadListFilters, null, true), "/api/threads?archived=true")
  assert.equal(threadListUrl(defaultThreadListFilters, "1:0c4d", true), "/api/threads?archived=true&cursor=1%3A0c4d")
  assert.equal(threadListUrl({ view: "all", q: "" }, null), "/api/threads")
})

test("pages merge by id keeping the first occurrence", () => {
  const first = { id: "a" }
  const second = { id: "b" }
  const stale = { id: "b", stale: true }
  const third = { id: "c" }
  assert.deepEqual(mergeThreadPages([[first, second], [stale, third]]), [first, second, third])
  assert.deepEqual(mergeThreadPages([]), [])
})
