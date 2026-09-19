import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { threadStatusText, type ThreadDisplayStatus } from "../src/lib/thread-status.ts"

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

test("both thread lists and conversation status use the same server-derived presentation", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.equal(source.match(/<ThreadLink /g)?.length, 2)
  assert.equal(source.match(/<ThreadStatusBadge status=\{current.display_status\}/g)?.length, 2)
  assert.doesNotMatch(source, /StatusDot|statusLabel|latestThreadAction/)
  assert.match(source, /thread=\{item.id === current.id \? current : item\}/)
})
