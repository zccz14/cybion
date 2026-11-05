import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")
const source = read("main.tsx")
// The page body lives in its own component so a fixture can render it; the
// shell keeps the route, the title and the navigation entry.
const page = read("components/insights.tsx")
const notes = read("lib/account-metrics.ts")

test("the page and its navigation are titled Usage statistics in both languages", () => {
  assert.match(source, /usageStats: "Usage statistics"/)
  assert.match(source, /usageStats: "用量统计"/)
  assert.doesNotMatch(source, /inferenceStats/)
  assert.match(source, /label: t\("usageStats"\)/)
  assert.match(source, /<Page title=\{t\("usageStats"\)\} description=\{t\("usageStatsDescription"\)\}>/)
  assert.match(source, /<InsightsView language=\{language\}/)
})

test("the page shows the snapshot time and the backfilling notice", () => {
  assert.match(page, /generated_at: number \| null/)
  assert.match(page, /backfilling: boolean/)
  assert.match(page, /statsGenerated: "Snapshot \{time\}"/)
  assert.match(page, /statsBackfilling: "/)
  assert.match(page, /formattedTime\(language, data\.generated_at\)/)
  assert.match(page, /data\.backfilling && /)
  assert.doesNotMatch(page, /attribution/)
})

test("by-model rows group by reasoning effort and expose request durations", () => {
  assert.match(page, /<th[^>]*>\{t\.reasoningEffort\}<\/th>/)
  assert.match(page, /key=\{JSON\.stringify\(\[item\.model, item\.reasoning_effort\]\)\}/)
  assert.match(page, /<code>\{item\.reasoning_effort \?\? "—"\}<\/code>/)
  assert.match(page, /item\.average_duration_seconds === null \? "—" : duration\(item\.average_duration_seconds\)/)
  assert.match(page, /\{duration\(item\.duration_seconds\)\}/)
})

test("worker cards show queue-to-result durations next to payload bytes", () => {
  assert.match(page, /\{duration\(data\.worker\.duration_seconds\)\}/)
  assert.match(page, /data\.worker\.average_duration_seconds === null \? "—" : duration\(data\.worker\.average_duration_seconds\)/)
  assert.match(page, /\{duration\(item\.duration_seconds\)\}/)
  assert.match(page, /formatBytes\(item\.read_bytes\)/)
})

test("reasoning audits expose the recorded reasoning effort", () => {
  const auditPage = source.slice(source.indexOf("function ReasoningAuditPage("), source.indexOf("function WorkerAuditPage("))
  assert.match(auditPage, /<th[^>]*>\{t\("reasoningEffort"\)\}<\/th>/)
  assert.match(auditPage, /<code>\{item\.reasoning_effort \?\? "—"\}<\/code>/)
})

test("usage statistics render the daily active-thread calendar", () => {
  assert.match(page, /activity: \{ timezone: string; days: InsightActiveDay\[\] \}/)
  assert.match(page, /<DailyActivityCard/)
  assert.match(page, /data\.activity\.days/)
  assert.match(page, /function DailyActivityCard\(/)
  assert.doesNotMatch(source + page, /DailyReports|ReportThreadNotice/)
})

test("daily activity defines non-checkpoint protocol records and exposes a UTC label", () => {
  assert.match(page, /A Thread is active when it has at least one non-checkpoint protocol record\./)
  assert.match(page, /statsDailyActivityDescription: "Thread 在某天至少产生一条非 checkpoint 协议记录时视为活跃。按 UTC 自然日统计，只计入所选范围内已封口的小时；不受模型和请求类型筛选影响。"/)
  assert.match(page, /<Badge variant="outline">\{t\.statsTimezone\}: \{timezone\}<\/Badge>/)
})


test("the reasoning audit page follows thread evidence links", () => {
  assert.match(source, /const threadFilter = filters\.get\("thread_id"\)/)
  assert.match(source, /if \(threadFilter\) params\.set\("thread_id", threadFilter\)/)
})

test("request outcomes and Worker calls are two stacked rows, not one split row", () => {
  // Side by side at xl they squeezed the Worker table below its readable width.
  assert.doesNotMatch(page, /grid gap-4 xl:grid-cols-2/)
  const stacked = page.slice(page.indexOf('data-slot="insight-requests"'), page.indexOf('data-slot="insight-history"'))
  assert.match(stacked, /data-slot="insight-worker"/)
  assert.match(page, /<div className="grid gap-4">/)
})

test("the account block reports the adminstrator's row from the same O(1) sources", () => {
  assert.match(page, /account: Account/)
  assert.match(page, /data-slot="insight-account"/)
  assert.match(page, /\{number\(metrics\.requests\)\}/)
  assert.match(page, /\{number\(metrics\.history_records\)\}/)
  assert.match(page, /\{number\(metrics\.running\.total\)\}/)
  assert.match(page, /formatBytes\(metrics\.sqlite_bytes\)/)
  assert.match(page, /traffic\?\.worker_sent_bytes \?\? 0/)
  assert.match(page, /traffic\?\.upstream_sent_bytes \?\? 0/)
  // The account's cache rate arrives as a ratio, unlike the range sections.
  assert.match(page, /value \* 100/)
  // One definitions block serves both pages.
  assert.match(page, /accountMetricNotes\[language\]/)
  assert.match(notes, /export const accountMetricNotes/)
})
