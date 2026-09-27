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
