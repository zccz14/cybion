import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { threadStatusLabel, threadStatusText, type ThreadDisplayStatus } from "../src/lib/thread-status.ts"

const statuses: ThreadDisplayStatus[] = ["ready", "running", "compacting", "completed", "failed", "stopped"]

test("every execution state has distinct labels and explanatory copy in both languages", () => {
  for (const language of ["zh", "en"] as const) {
    const labels = statuses.map((status) => threadStatusText(status, language).label)
    assert.equal(new Set(labels).size, statuses.length)
    for (const status of statuses) {
      const { label, hint } = threadStatusText(status, language)
      assert.ok(label.length > 0)
      assert.ok(hint.length > label.length)
    }
  }
  assert.equal(threadStatusText("completed", "zh").label, "已完成")
  assert.equal(threadStatusText("stopped", "zh").label, "已停止")
  assert.equal(threadStatusText("ready", "en").label, "Ready")
})

test("a running Thread shows the newest Worker call's intent summary instead of the running label", () => {
  assert.equal(threadStatusLabel("running", "zh", " 检查磁盘 "), "检查磁盘")
  assert.equal(threadStatusLabel("running", "en", "check the build log"), "check the build log")
  for (const summary of [null, undefined, "", "   "]) {
    assert.equal(threadStatusLabel("running", "zh", summary), "运行中")
  }
  // Only the running state borrows the summary; terminal states keep their own copy.
  assert.equal(threadStatusLabel("completed", "zh", "检查磁盘"), "已完成")
  assert.equal(threadStatusLabel("compacting", "en", "check the build log"), "Compacting")
})

test("both thread lists and conversation status use the same server-derived presentation", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  // INVARIANT: every surface that lists a Thread renders the same polled row — the narrow
  // page, the sidebar beside a new Thread, the sidebar beside an open one and the archived
  // group — so no spot can invent its own status presentation or need a per-row override.
  assert.equal(list.match(/<ThreadLink /g)?.length, 3)
  assert.equal(source.match(/<ThreadLink /g), null)
  assert.equal(source.match(/<ThreadStatusBadge status=\{current.display_status\} runningSummary=\{current.running_summary\}/g)?.length, 1)
  assert.match(source, /<ThreadStatusSummary status=\{current.display_status\} runningSummary=\{current.running_summary\} language=\{language\} \/>/)
  assert.doesNotMatch(source, /StatusDot|statusLabel|latestThreadAction/)
})

test("thread list rows show how long ago each thread was last updated", () => {
  const source = readFileSync(new URL("../src/components/thread-status.tsx", import.meta.url), "utf8")
  assert.match(source, /data-slot="thread-updated-at"/)
  assert.match(source, /formatRelativeTime\(language, thread\.updated_at, now\)/)
})
