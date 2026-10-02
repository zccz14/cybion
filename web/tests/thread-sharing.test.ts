import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { sharedThreadPath, sharedThreadQueryKey, sharedThreadReturnHash, sharingAccessLost } from "../src/lib/thread-sharing.ts"

const id = "00000000-0000-4000-8000-000000000001"
test("share callback preserves only validated same-origin identity routes, never query secrets", () => {
  const hash = `#/shared-threads/owner/${id}`
  assert.equal(sharedThreadReturnHash(hash), hash)
  assert.equal(sharedThreadReturnHash(`${hash}?token=private`), hash)
  for (const value of ["https://evil.test", "#//evil.test", `#/shared-threads/../${id}/other`, `#/shared-threads/owner%2Fother/${id}`, `#/shared-threads/owner/${id}/inputs`, "#/shared-threads/owner/not-a-uuid"]) assert.equal(sharedThreadReturnHash(value), null)
  assert.equal(sharedThreadPath("owner/other", id), `/shared-threads/owner%2Fother/${id}`)
})
test("shared caches distinguish session, viewer, owner and same-ID Threads", () => {
  const first = sharedThreadQueryKey("session", "viewer", "owner", id)
  for (const key of [sharedThreadQueryKey("session2", "viewer", "owner", id), sharedThreadQueryKey("session", "viewer2", "owner", id), sharedThreadQueryKey("session", "viewer", "owner2", id), sharedThreadQueryKey("session", "viewer", "owner", "other")]) assert.notDeepEqual(first, key)
})
test("only authentication and authorization failures end the reader, temporary failures stay retryable", () => {
  for (const status of [401, 403, 404]) assert.equal(sharingAccessLost(Object.assign(new Error("denied"), { status })), true)
  for (const status of [400, 409, 429, 500, 503]) assert.equal(sharingAccessLost(Object.assign(new Error("retry"), { status })), false)
  assert.equal(sharingAccessLost(new Error("offline")), false)
})
test("production integration keeps the shared reader separate from owner execution and configuration", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const shared = readFileSync(new URL("../src/components/shared-threads.tsx", import.meta.url), "utf8")
  assert.match(main, /<ThreadSharingButton userId=\{userId\}/)
  assert.match(main, /path="\/shared-threads\/:ownerId\/:threadId"/)
  assert.match(main, /sharedThreadReturnHash\(location.hash\)/)
  assert.match(main, /HistoryMessage language=\{language\} record=\{record\} workers=\{undefined\}/)
  for (const forbidden of ["/inputs", "/cancel", "/continue", "/compact", "/api/workers", "thread-defaults", "upstream-models", "ThreadSettingsPopover", "useComposerDraft", "localStorage"]) assert.ok(!shared.includes(forbidden), forbidden)
  assert.match(shared, /signal/)
  assert.match(shared, /cancelQueries/)
  assert.match(shared, /removeQueries/)
})
