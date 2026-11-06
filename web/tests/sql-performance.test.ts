import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  callerLabel,
  callerSource,
  formatScanPerCall,
  formatShare,
  scanSeverity,
  sortStatements,
  sqlPreview,
  sqlSeriesPeak,
  type SqlStatement,
} from "../src/lib/sql-performance.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const page = readFileSync(new URL("../src/components/sql-performance.tsx", import.meta.url), "utf8")

const statement = (overrides: Partial<SqlStatement>): SqlStatement => ({
  key: "1",
  sql: "SELECT 1",
  caller: "src/cloud.rs:1:1",
  statements: 1,
  total_us: 1_000,
  fullscan_steps: 0,
  fullscan_per_call: 0,
  slow_statements: 0,
  average_us: 1_000,
  p50_us: 0,
  p95_us: 0,
  p99_us: 0,
  max_us: 1_000,
  ...overrides,
})

test("the profiler's own share keeps the precision a few hundred ppm needs", () => {
  assert.equal(formatShare(null), "—")
  assert.equal(formatShare(0), "0%")
  // 450 ppm is 0.045%: rounding that to one decimal would print 0.0%.
  assert.equal(formatShare(450), "0.045%")
  assert.equal(formatShare(1_718), "0.172%")
  assert.equal(formatShare(7_500), "0.750%")
  assert.equal(formatShare(187_760), "18.78%")
})

test("scan severity separates a point lookup from a table walk", () => {
  assert.equal(scanSeverity(null), "none")
  assert.equal(scanSeverity(0), "none")
  assert.equal(scanSeverity(1), "some")
  assert.equal(scanSeverity(99), "some")
  // 884 rows per call is the thread list this audit was built for.
  assert.equal(scanSeverity(884), "wide")
  assert.equal(scanSeverity(1_000), "full")
  // 141,568 rows per call is the settlement scan.
  assert.equal(scanSeverity(141_568), "full")
})

test("a scan count is a count of steps, so it is never shown as a fraction", () => {
  const number = (value: number) => value.toLocaleString("en")
  assert.equal(formatScanPerCall(null, number), "—")
  assert.equal(formatScanPerCall(0, number), "—")
  assert.equal(formatScanPerCall(884.4, number), "884")
  assert.equal(formatScanPerCall(141_568, number), "141,568")
})

test("statements are ranked by the value asked for, then by key so rows never swap", () => {
  const cheapAndFrequent = statement({ key: "a", statements: 7_572, total_us: 19_180_000 })
  const expensive = statement({ key: "b", statements: 10, total_us: 4_000_000 })
  const byTotal = sortStatements([cheapAndFrequent, expensive], "total_us", true)
  assert.deepEqual(byTotal.map((row) => row.key), ["a", "b"])
  const ascending = sortStatements([cheapAndFrequent, expensive], "total_us", false)
  assert.deepEqual(ascending.map((row) => row.key), ["b", "a"])

  // A null percentile sorts last in both directions instead of winning with -1.
  const missing = statement({ key: "c", p95_us: null })
  const present = statement({ key: "d", p95_us: 25_000 })
  assert.deepEqual(sortStatements([missing, present], "p95_us", true).map((row) => row.key), ["d", "c"])
  assert.deepEqual(sortStatements([present, missing], "p95_us", false).map((row) => row.key), ["c", "d"])
})

test("the statement text is one line, cut with an ellipsis, and the call site drops the workspace prefix", () => {
  assert.equal(sqlPreview("SELECT\n  1"), "SELECT 1")
  const long = "SELECT " + "x".repeat(300)
  const preview = sqlPreview(long)
  assert.equal(preview.length, 140)
  assert.match(preview, /…$/)
  assert.equal(callerLabel("src/cloud.rs:4045:5"), "cloud.rs:4045:5")
  assert.equal(callerLabel("cloud::stats::patrol"), "cloud::stats::patrol")
})

test("a call site is attributed to the lane that issued it", () => {
  assert.equal(callerSource("cloud::stats::patrol"), "patrol")
  assert.equal(callerSource("src/cloud/cost.rs:10:2"), "patrol")
  assert.equal(callerSource("src/cloud/worker_protocol.rs:604:9"), "worker")
  assert.equal(callerSource("src/cloud/machines.rs:660:19"), "worker")
  assert.equal(callerSource("src/cloud/integration.rs:20:1"), "integration")
  // Everything else is a browser handler, which shares the same lane.
  assert.equal(callerSource("src/cloud.rs:4045:5"), "browser")
})

test("an idle window still scales its chart instead of dividing by zero", () => {
  assert.equal(sqlSeriesPeak([]), 1)
  const series = [{ bucket_start: 1, statements: 900, total_us: 1, slow_statements: 0, fullscan_steps: 0, p95_us: 12_000 }]
  assert.equal(sqlSeriesPeak(series), 900)
  assert.equal(sqlSeriesPeak(series, "p95_us"), 12_000)
  assert.equal(sqlSeriesPeak([{ ...series[0], p95_us: null }], "p95_us"), 1)
})

test("the page is wired as an administrator-only audit page", () => {
  assert.match(source, /sqlPerformance: "SQL performance"/)
  assert.match(source, /sqlPerformance: "SQL 性能"/)
  assert.match(source, /<Route path="\/sql-performance" element=\{<SqlPerformancePage sdk=\{sdk\} isAdmin=\{isAdmin\} \/>\} \/>/)
  assert.match(source, /<SqlPerformance language=\{language\} sessionId=\{sdk\.session\.getState\(\)\.sessionId\}/)
  assert.match(source, /allowed=\{isAdmin\}/)
  assert.match(source, /if \(pathname\.startsWith\("\/sql-performance"\)\) return t\("sqlPerformance"\)/)
  // The audit is cross-tenant: a non-administrator is told why, and no request
  // is fired on their behalf.
  assert.match(page, /enabled: allowed/)
  assert.match(page, /if \(!allowed\) return/)
})
