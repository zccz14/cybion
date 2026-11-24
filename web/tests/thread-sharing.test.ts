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
test("both sharing surfaces pick recipients through the package-owned Linkit user picker", () => {
  for (const file of ["../src/components/worker-sharing.tsx", "../src/components/thread-sharing.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.match(source, /import \{ (?:LinkitUserInfo, )?LinkitUserPicker \} from "linkit-react-components"/)
    assert.match(source, /<LinkitUserPicker lang=\{language === "zh" \? "zh-CN" : "en-US"\} label=\{t\.recipient\} value=\{recipient\} onValueChange=\{\(next\) => \{ setRecipient\(next\); setConsent\(false\); grant\.reset\(\) \}\} \/>/)
    assert.doesNotMatch(source, /Recipient user ID/)
    assert.doesNotMatch(source, /aria-invalid/)
  }
})

test("the Thread share control is an icon-only button that keeps its accessible name and granted count", () => {
  const source = readFileSync(new URL("../src/components/thread-sharing.tsx", import.meta.url), "utf8")
  assert.match(source, /size="icon-sm" aria-label=\{grants\.error \? t\.unknown : active \? `\$\{t\.shared\} · \$\{active\}` : t\.share\} title=\{active \? t\.ongoing : t\.description\}>\s*<Share2Icon \/>\s*<\/Button>/)
})

test("granted people render through the package-owned Linkit user info instead of raw IDs", () => {
  const source = readFileSync(new URL("../src/components/thread-sharing.tsx", import.meta.url), "utf8")
  assert.match(source, /<LinkitUserInfo userId=\{g\.grantee_user_id\} compact \/>/)
  assert.doesNotMatch(source, /<code className="min-w-0 basis-full/)
})

test("the shared category and its reader name the owner through Linkit and never print the viewer's own ID", () => {
  // Sharing has no list of its own any more: one row of the Thread list carries the
  // owner, and the reader's header carries the same identity.
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  const reader = readFileSync(new URL("../src/components/shared-threads.tsx", import.meta.url), "utf8")
  assert.match(list, /import \{ LinkitUserInfo \} from "linkit-react-components"/)
  assert.match(list, /badge: <LinkitUserInfo userId=\{item\.owner_user_id\} compact \/>/)
  assert.match(reader, /import \{ LinkitUserInfo \} from "linkit-react-components"/)
  assert.match(reader, /<LinkitUserInfo userId=\{ownerId\} compact \/>/)
  for (const source of [list, reader]) assert.doesNotMatch(source, /SharingUserId/)
  assert.doesNotMatch(reader, /\{t\.owner\}: \{/)
  const sharing = readFileSync(new URL("../src/components/thread-sharing.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(sharing, /SharingUserId|My user ID|我的用户 ID/)
})
test("the shared reader is the one conversation view over a read-only source, never an owner session", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const reader = readFileSync(new URL("../src/components/shared-threads.tsx", import.meta.url), "utf8")
  const view = readFileSync(new URL("../../packages/cybion-components/src/thread-view.tsx", import.meta.url), "utf8")
  assert.match(main, /<ThreadSharingButton userId=\{userId\}/)
  assert.match(main, /path="\/shared-threads\/:ownerId\/:threadId"/)
  // A share is its own list category; the standalone page only redirects to it.
  assert.match(main, /path="\/shared-threads" element=\{<Navigate to=\{\{ pathname: "\/threads", search: "\?view=shared" \}\}/)
  assert.match(main, /sharedThreadReturnHash\(location\.hash\)/)
  // The reader renders the package's view with a source and `readOnly`, so there is one
  // transcript renderer and one scroller rather than a second, thinner copy.
  assert.match(reader, /<CybionThreadView/)
  assert.match(reader, /source=\{source\}/)
  assert.match(reader, /readOnly/)
  assert.doesNotMatch(reader, /HistoryMessage/)
  // Nothing in the reader can reach owner execution or owner configuration.
  for (const forbidden of ["/inputs", "/cancel", "/continue", "/compact", "/api/workers", "thread-defaults", "upstream-models", "ThreadSettingsPopover", "useComposerDraft", "localStorage"]) assert.ok(!reader.includes(forbidden), forbidden)
  // Losing access drops the whole scope instead of retrying it.
  assert.match(reader, /accessLost: sharingAccessLost/)
  assert.match(reader, /cancelQueries/)
  assert.match(reader, /removeQueries/)
  // And the view itself refuses to write while a source is in play.
  assert.match(view, /const writable = !source && !readOnly/)
})
