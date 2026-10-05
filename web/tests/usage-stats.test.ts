import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const insightsPage = source.slice(source.indexOf("function InsightsPage("), source.indexOf("function ReasoningAuditPage("))

test("the page and its navigation are titled Usage statistics in both languages", () => {
  assert.match(source, /usageStats: "Usage statistics"/)
  assert.match(source, /usageStats: "用量统计"/)
  assert.doesNotMatch(source, /inferenceStats/)
  assert.match(source, /label: t\("usageStats"\)/)
  assert.match(insightsPage, /<Page title=\{t\("usageStats"\)\} description=\{t\("usageStatsDescription"\)\}>/)
})

test("the page shows the snapshot time and the backfilling notice", () => {
  assert.match(source, /generated_at: number \| null/)
  assert.match(source, /backfilling: boolean/)
  assert.match(source, /statsGenerated: "Snapshot \{time\}"/)
  assert.match(source, /statsBackfilling: "/)
  assert.match(insightsPage, /formattedTime\(language, data\.generated_at\)/)
  assert.match(insightsPage, /data\.backfilling && /)
  assert.doesNotMatch(insightsPage, /attribution/)
})

test("by-model rows group by reasoning effort and expose request durations", () => {
  assert.match(insightsPage, /<th[^>]*>\{t\("reasoningEffort"\)\}<\/th>/)
  assert.match(insightsPage, /key=\{JSON\.stringify\(\[item\.model, item\.reasoning_effort\]\)\}/)
  assert.match(insightsPage, /<code>\{item\.reasoning_effort \?\? "—"\}<\/code>/)
  assert.match(insightsPage, /item\.average_duration_seconds === null \? "—" : duration\(item\.average_duration_seconds\)/)
  assert.match(insightsPage, /\{duration\(item\.duration_seconds\)\}/)
})

test("worker cards show queue-to-result durations next to payload bytes", () => {
  assert.match(insightsPage, /\{duration\(data\.worker\.duration_seconds\)\}/)
  assert.match(insightsPage, /data\.worker\.average_duration_seconds === null \? "—" : duration\(data\.worker\.average_duration_seconds\)/)
  assert.match(insightsPage, /\{duration\(item\.duration_seconds\)\}/)
  assert.match(insightsPage, /formatBytes\(item\.read_bytes\)/)
})

test("reasoning audits expose the recorded reasoning effort", () => {
  const auditPage = source.slice(source.indexOf("function ReasoningAuditPage("), source.indexOf("function WorkerAuditPage("))
  assert.match(auditPage, /<th[^>]*>\{t\("reasoningEffort"\)\}<\/th>/)
  assert.match(auditPage, /<code>\{item\.reasoning_effort \?\? "—"\}<\/code>/)
})

test("usage statistics render the daily active-thread calendar", () => {
  assert.match(source, /activity: \{ timezone: string; days: InsightActiveDay\[\] \}/)
  assert.match(insightsPage, /<DailyActivityCard/)
  assert.match(insightsPage, /data\.activity\.days/)
  assert.match(source, /function DailyActivityCard\(/)
  assert.doesNotMatch(source, /DailyReports|ReportThreadNotice/)
})

test("daily activity defines non-checkpoint protocol records and exposes a UTC label", () => {
  assert.match(source, /A Thread is active when it has at least one non-checkpoint protocol record\./)
  assert.match(source, /statsDailyActivityDescription: "Thread 在某天至少产生一条非 checkpoint 协议记录时视为活跃。按 UTC 自然日统计，只计入所选范围内已封口的小时；不受模型和请求类型筛选影响。"/)
  assert.match(source, /<Badge variant="outline">\{t\("statsTimezone"\)\}: \{timezone\}<\/Badge>/)
})


test("the reasoning audit page follows thread evidence links", () => {
  assert.match(source, /const threadFilter = filters\.get\("thread_id"\)/)
  assert.match(source, /if \(threadFilter\) params\.set\("thread_id", threadFilter\)/)
})
