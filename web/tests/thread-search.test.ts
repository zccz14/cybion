import assert from "node:assert/strict"
import test from "node:test"

import { allThreadListFilters, defaultThreadListFilters, hasThreadListFilters, mergeThreadPages, parseThreadListFilters, serializeThreadListFilters, threadListUrl } from "../src/lib/thread-search.ts"

test("the default view lists my threads", () => {
  assert.deepEqual(defaultThreadListFilters, { view: "mine", q: "" })
  assert.equal(threadListUrl(defaultThreadListFilters), "/api/threads?origin=web")
})

test("the widest selection shows every active thread", () => {
  assert.equal(threadListUrl(allThreadListFilters), "/api/threads")
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
  assert.equal(hasThreadListFilters({ view: "mine", q: "" }), true)
  assert.equal(hasThreadListFilters({ view: "failed", q: "" }), true)
  assert.equal(hasThreadListFilters({ view: "all", q: "bridge" }), true)
})

test("cursors and the archived scope append to the query", () => {
  assert.equal(threadListUrl({ view: "all", q: "" }, "123:0c4d"), "/api/threads?cursor=123%3A0c4d")
  assert.equal(threadListUrl({ view: "api", q: "room" }, "456:9f2e"), "/api/threads?origin=api&q=room&cursor=456%3A9f2e")
  assert.equal(threadListUrl(allThreadListFilters, null, true), "/api/threads?archived=true")
  assert.equal(threadListUrl(allThreadListFilters, "1:0c4d", true), "/api/threads?archived=true&cursor=1%3A0c4d")
  assert.equal(threadListUrl({ view: "all", q: "" }, null), "/api/threads")
})

test("thread list filters parse from the URL, falling back to my threads", () => {
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("")), { view: "mine", q: "" })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=all")), { view: "all", q: "" })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=api&q=room")), { view: "api", q: "room" })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=bogus&q=x")), { view: "mine", q: "x" })
})

test("thread list filters serialize into the URL, skipping defaults and keeping raw search text", () => {
  assert.equal(serializeThreadListFilters(defaultThreadListFilters).toString(), "")
  assert.equal(serializeThreadListFilters(allThreadListFilters).toString(), "view=all")
  const raw = serializeThreadListFilters({ view: "mine", q: " room " })
  assert.equal(raw.get("view"), null)
  assert.equal(raw.get("q"), " room ")
  assert.equal(serializeThreadListFilters({ view: "failed", q: "   " }).toString(), "view=failed")
})

test("thread list filters round-trip through the URL", () => {
  const cases = [defaultThreadListFilters, allThreadListFilters, { view: "api", q: "room/1" }, { view: "failed", q: "  x " }]
  for (const filters of cases) assert.deepEqual(parseThreadListFilters(serializeThreadListFilters(filters)), filters)
})

test("pages merge by id keeping the first occurrence", () => {
  const first = { id: "a" }
  const second = { id: "b" }
  const stale = { id: "b", stale: true }
  const third = { id: "c" }
  assert.deepEqual(mergeThreadPages([[first, second], [stale, third]]), [first, second, third])
  assert.deepEqual(mergeThreadPages([]), [])
})
