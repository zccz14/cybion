import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { composerDraftKey, removeSubmittedDraft } from "../src/lib/composer-drafts.ts"
import { readPackageSource } from "./package-source.ts"

test("draft keys isolate users, threads and the shared new-thread composer", () => {
  const keys = [composerDraftKey("a", null), composerDraftKey("a", "1"), composerDraftKey("a", "2"), composerDraftKey("b", "1"), composerDraftKey("b", null), composerDraftKey("a", "new"), composerDraftKey("a:thread", "1"), composerDraftKey("a", "thread:1")]
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(composerDraftKey("a", "1"), composerDraftKey("a", "1"))
})

test("a successful send removes only the matching raw draft, never a newer edit", () => {
  const saved = new Map([["a", "  hello\n世界  "], ["b", "keep"]])
  const storage = { getItem: (key: string) => saved.get(key) ?? null, removeItem: (key: string) => { saved.delete(key) } }
  removeSubmittedDraft(storage, "a", "hello\n世界")
  assert.equal(saved.get("a"), "  hello\n世界  ")
  removeSubmittedDraft(storage, "a", "older draft")
  assert.equal(saved.get("a"), "  hello\n世界  ")
  removeSubmittedDraft(storage, "a", "  hello\n世界  ")
  assert.equal(saved.has("a"), false)
  assert.equal(saved.get("b"), "keep")
})

test("actual composers bind drafts to verified ownership and clear only after accepted input", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const view = readPackageSource("thread-view.tsx")
  assert.match(main, /currentUser.isPending \? <LoadingScreen/)
  assert.match(main, /key=\{currentUser.data.user_id\}/)
  assert.match(main, /<ThreadConversation key=\{threadId\}/)
  assert.match(main, /useComposerDraft\(userId, null\)/)
  // The conversation composer takes the verified owner as its draft scope.
  assert.match(view, /useComposerDraft\(identity, threadId\)/)
  assert.match(main, /clearSubmitted\(payload.input\)/)
  assert.match(view, /draft.clearSubmitted\(input\)/)
  for (const source of [main, view]) {
    assert.equal(source.match(/useComposerImages\(\)/g)?.length, 1)
    assert.equal(source.match(/attachments\.clear\(\)/g)?.length, 1)
    assert.equal(source.match(/<ComposerDraftNotice/g)?.length, 1)
  }
  assert.match(main, /removeItem\(composerDraftKey\(userId, threadId\)\)/)
  assert.match(main, /const \{ initialInput, \.\.\.state \} = location.state/)
  assert.match(main, /replace: true, state/)
})
