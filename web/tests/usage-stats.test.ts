import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const reportSource = readFileSync(new URL("../src/components/daily-reports.tsx", import.meta.url), "utf8")
const insightsPage = source.slice(source.indexOf("function InsightsPage("), source.indexOf("function ReasoningAuditPage("))

test("the page and its navigation are titled Usage statistics in both languages", () => {
  assert.match(source, /usageStats: "Usage statistics"/)
  assert.match(source, /usageStats: "用量统计"/)
  assert.doesNotMatch(source, /inferenceStats/)
  assert.match(source, /label: t\("usageStats"\)/)
  assert.match(insightsPage, /<Page title=\{t\("usageStats"\)\} description=\{t\("usageStatsDescription"\)\}>/)
})

test("run time attribution renders the three parts, their shares, and the run count", () => {
  assert.match(insightsPage, /<CardTitle>\{t\("statsTimeAttribution"\)\}<\/CardTitle>/)
  assert.match(insightsPage, /\{duration\(data\.attribution\.running_seconds\)\}/)
  assert.match(insightsPage, /\{duration\(data\.attribution\.inference_seconds\)\}<\/dd><p[^>]*>\{share\(data\.attribution\.inference_seconds\)\}<\/p>/)
  assert.match(insightsPage, /\{duration\(data\.attribution\.worker_seconds\)\}<\/dd><p[^>]*>\{share\(data\.attribution\.worker_seconds\)\}<\/p>/)
  assert.match(insightsPage, /\{duration\(data\.attribution\.overhead_seconds\)\}<\/dd><p[^>]*>\{share\(data\.attribution\.overhead_seconds\)\}<\/p>/)
  assert.match(insightsPage, /statsRunsCounted"\)\.replace\("\{count\}", number\(data\.attribution\.runs\)\)/)
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

test("usage statistics render the daily active-thread calendar and selected daily report", () => {
  assert.match(source, /activity: \{ timezone: string; days: InsightActiveDay\[\] \}/)
  assert.match(insightsPage, /<DailyActivityCard/)
  assert.match(insightsPage, /data\.activity\.days/)
  assert.match(source, /function DailyActivityCard\(/)
  assert.match(insightsPage, /<DailyReports/)
  assert.match(reportSource, /`\/api\/reports\/daily\?date=\$\{encodeURIComponent\(date!\)\}`/)
})

test("daily activity defines non-checkpoint protocol records and exposes a UTC label", () => {
  assert.match(source, /A Thread is active when it has at least one non-checkpoint protocol record\./)
  assert.match(source, /statsDailyActivityDescription: "Thread 在某天至少产生一条非 checkpoint 协议记录时视为活跃。按 UTC 自然日统计，包含范围首日的完整数据；不受模型和请求类型筛选影响。"/)
  assert.match(source, /<Badge variant="outline">\{t\("statsTimezone"\)\}: \{timezone\}<\/Badge>/)
})


test("report execution is visibly scoped to its Thread and audit filters follow evidence links", () => {
  assert.match(reportSource, /\/api\/reports\/thread/)
  assert.match(reportSource, /reportAuditPath\(reportThread.id\)/)
  assert.match(reportSource, /control\.mutate\("cancel"\)/)
  assert.match(reportSource, /control\.mutate\("continue"\)/)
  assert.match(source, /current\.purpose === "reports" && <ReportThreadNotice/)
  assert.match(source, /const threadFilter = filters\.get\("thread_id"\)/)
  assert.match(source, /if \(threadFilter\) params\.set\("thread_id", threadFilter\)/)
})
