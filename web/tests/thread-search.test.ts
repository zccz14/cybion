import assert from "node:assert/strict"
import test from "node:test"

import { allThreadListFilters, defaultThreadListFilters, hasThreadListFilters, isSharedThreadListView, mergeThreadPages, parseThreadListFilters, serializeThreadListFilters, sharedThreadsUrl, threadListUrl } from "../src/lib/thread-search.ts"

test("the default view lists my threads", () => {
  assert.deepEqual(defaultThreadListFilters, { view: "mine", q: "", hidden: false })
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
  assert.equal(threadListUrl({ view: "blocked", q: "" }), "/api/threads?blocked=true")
  assert.equal(threadListUrl({ view: "archived", q: "" }), "/api/threads?archived=true")
  // Sharing is a category of the same list, but it read the other endpoint; the builder
  // that names it takes no search text and no view parameters.
  assert.equal(sharedThreadsUrl(false), "/api/shared-threads?hidden=false")
  assert.equal(sharedThreadsUrl(true, "abc"), "/api/shared-threads?hidden=true&cursor=abc")
  assert.equal(isSharedThreadListView("shared"), true)
  assert.equal(isSharedThreadListView("mine"), false)
})

test("search text is trimmed, encoded, and combined with the view", () => {
  assert.equal(threadListUrl({ view: "api", q: "  room/1  " }), "/api/threads?origin=api&q=room%2F1")
  assert.equal(threadListUrl({ view: "all", q: "   " }), "/api/threads")
  assert.equal(hasThreadListFilters({ view: "all", q: "  ", hidden: false }), false)
  assert.equal(hasThreadListFilters({ view: "mine", q: "", hidden: false }), true)
  assert.equal(hasThreadListFilters({ view: "failed", q: "", hidden: false }), true)
  assert.equal(hasThreadListFilters({ view: "blocked", q: "", hidden: false }), true)
  assert.equal(hasThreadListFilters({ view: "all", q: "bridge", hidden: false }), true)
  // Hiding shares is a narrowing of the shared category, so it counts as a filter.
  assert.equal(hasThreadListFilters({ view: "all", q: "", hidden: true }), true)
})

test("cursors append to the query and the archived view scopes the list", () => {
  assert.equal(threadListUrl({ view: "all", q: "" }, "123:0c4d"), "/api/threads?cursor=123%3A0c4d")
  assert.equal(threadListUrl({ view: "api", q: "room" }, "456:9f2e"), "/api/threads?origin=api&q=room&cursor=456%3A9f2e")
  assert.equal(threadListUrl({ view: "archived", q: "" }, "1:0c4d"), "/api/threads?archived=true&cursor=1%3A0c4d")
  assert.equal(threadListUrl({ view: "archived", q: " legacy " }, null), "/api/threads?archived=true&q=legacy")
  assert.equal(threadListUrl({ view: "all", q: "" }, null), "/api/threads")
})

test("thread list filters parse from the URL, falling back to my threads", () => {
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("")), { view: "mine", q: "", hidden: false })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=all")), { view: "all", q: "", hidden: false })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=api&q=room")), { view: "api", q: "room", hidden: false })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=bogus&q=x")), { view: "mine", q: "x", hidden: false })
  // The hidden flag only means something inside the shared category.
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=shared&hidden=1")), { view: "shared", q: "", hidden: true })
  assert.deepEqual(parseThreadListFilters(new URLSearchParams("view=all&hidden=1")), { view: "all", q: "", hidden: false })
})

test("thread list filters serialize into the URL, skipping defaults and keeping raw search text", () => {
  assert.equal(serializeThreadListFilters(defaultThreadListFilters).toString(), "")
  assert.equal(serializeThreadListFilters(allThreadListFilters).toString(), "view=all")
  const raw = serializeThreadListFilters({ view: "mine", q: " room " })
  assert.equal(raw.get("view"), null)
  assert.equal(raw.get("q"), " room ")
  assert.equal(serializeThreadListFilters({ view: "failed", q: "   " }).toString(), "view=failed")
  assert.equal(serializeThreadListFilters({ view: "shared", q: "", hidden: true }).toString(), "view=shared&hidden=1")
  assert.equal(serializeThreadListFilters({ view: "shared", q: "", hidden: false }).toString(), "view=shared")
})

test("thread list filters round-trip through the URL", () => {
  const cases = [defaultThreadListFilters, allThreadListFilters, { view: "api", q: "room/1", hidden: false }, { view: "failed", q: "  x ", hidden: false }, { view: "archived", q: "legacy", hidden: false }, { view: "shared", q: "", hidden: true }]
  for (const filters of cases) assert.deepEqual(parseThreadListFilters(serializeThreadListFilters(filters)), filters)
})

test("pages merge by the key the caller names, keeping the first occurrence", () => {
  const first = { id: "a" }
  const second = { id: "b" }
  const stale = { id: "b", stale: true }
  const third = { id: "c" }
  assert.deepEqual(mergeThreadPages([[first, second], [stale, third]], (item) => item.id), [first, second, third])
  assert.deepEqual(mergeThreadPages([], (item: { id: string }) => item.id), [])
  // A share is identified by its owner as well: two owners can share Threads that
  // happen to carry the same id, and both rows belong on the list.
  const mine = { owner: "a", id: "t" }
  const theirs = { owner: "b", id: "t" }
  assert.deepEqual(mergeThreadPages([[mine], [theirs]], (item) => `${item.owner}:${item.id}`), [mine, theirs])
})
