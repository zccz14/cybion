import { formatLatency } from "./route-performance.ts"

export type SqlPerformanceWindow = "1h" | "6h" | "24h" | "7d"

export type SqlOverhead = {
  /** Every statement the profiler saw, including the ones it never timed. */
  statements: number
  timed_statements: number
  /** Extrapolated cost of the profiler itself, in microseconds. */
  recorder_us: number
  /** Profiler cost over the last completed interval, parts per million. */
  share_ppm: number
  /** Worst interval since the process started. */
  worst_ppm: number
  /** Statements the fixed table had no room for; any value here is a lost sample. */
  unattributed: number
}

export type SqlTotals = {
  statements: number
  total_us: number
  fullscan_steps: number
  slow_statements: number
  average_us: number | null
  p50_us: number | null
  p95_us: number | null
  p99_us: number | null
  max_us: number | null
}

export type SqlStatement = {
  key: string
  sql: string
  caller: string
  statements: number
  total_us: number
  fullscan_steps: number
  fullscan_per_call: number | null
  slow_statements: number
  average_us: number | null
  p50_us: number | null
  p95_us: number | null
  p99_us: number | null
  max_us: number | null
}

export type SqlBucket = {
  bucket_start: number
  statements: number
  total_us: number
  slow_statements: number
  fullscan_steps: number
  p95_us: number | null
}

export type SqlSlow = {
  sampled_at: number
  key: string
  sql: string
  caller: string
  latency_us: number
  fullscan_steps: number
}

export type SqlPerformance = {
  window: SqlPerformanceWindow
  resolution: "minute" | "hour"
  bucket_seconds: number
  generated_at: number
  latest_bucket_start: number | null
  enabled: boolean
  overhead: SqlOverhead
  totals: SqlTotals
  statements: SqlStatement[]
  series: SqlBucket[]
  slow: SqlSlow[]
}

export const sqlPerformanceWindows: SqlPerformanceWindow[] = ["1h", "6h", "24h", "7d"]

/// Which side of the lane a statement belongs to, read off the call site the
/// profiler recorded: the device protocol, the integration API or the browser
/// handlers.
export type SqlCallerSource = "browser" | "worker" | "integration" | "patrol"

export function callerSource(caller: string): SqlCallerSource {
  if (caller.startsWith("cloud::") || caller.startsWith("src/cloud/stats") || caller.startsWith("src/cloud/cost")) return "patrol"
  if (caller.includes("worker_protocol") || caller.includes("worker_sharing") || caller.includes("machines") || caller.includes("exe")) return "worker"
  if (caller.includes("integration")) return "integration"
  return "browser"
}

/// How much of the table a statement walks per execution. This is the column
/// that separates "slow once" from "reads everything every time": the settlement
/// scan this audit was built for ran in 18 ms while reading 141,568 rows, and a
/// latency-only ranking hides it.
export type ScanSeverity = "none" | "some" | "wide" | "full"

export function scanSeverity(perCall: number | null): ScanSeverity {
  if (perCall === null || perCall <= 0) return "none"
  if (perCall < 100) return "some"
  if (perCall < 1_000) return "wide"
  return "full"
}

/// Parts per million as a percentage, at the precision a few hundred ppm needs:
/// "0.045%" is a real answer, "0.0%" is not.
export function formatShare(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return "—"
  const percent = ppm / 10_000
  if (percent === 0) return "0%"
  if (percent < 0.01) return `${percent.toFixed(4)}%`
  if (percent < 1) return `${percent.toFixed(3)}%`
  return `${percent.toFixed(2)}%`
}

/// A statement's full-scan steps per call, rounded: the number is a count of
/// b-tree advances, so a fraction of one means nothing.
export function formatScanPerCall(perCall: number | null | undefined, number: (value: number) => string): string {
  if (perCall === null || perCall === undefined) return "—"
  if (perCall <= 0) return "—"
  return number(Math.round(perCall))
}

/// The SQL text as a single line, cut to a width the table can show. The whole
/// statement stays available through the cell's title.
export function sqlPreview(sql: string, limit = 140): string {
  const line = sql.replace(/\s+/g, " ").trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

/// The call site without the workspace prefix, which is the same for all of
/// them and only steals width.
export function callerLabel(caller: string): string {
  return caller.replace(/^src\//, "").replace(/^cloud\//, "")
}

export type SqlSortKey =
  | "statements"
  | "total_us"
  | "fullscan_per_call"
  | "average_us"
  | "p95_us"
  | "max_us"
  | "slow_statements"

const statementOrder = (left: SqlStatement, right: SqlStatement) => left.key.localeCompare(right.key)

/// Sorting the statement table: the value asked for, largest first, with a
/// stable order underneath so equal rows never swap places between renders.
export function sortStatements(statements: SqlStatement[], key: SqlSortKey, descending: boolean): SqlStatement[] {
  const value = (statement: SqlStatement) => statement[key] ?? -1
  return [...statements].sort((left, right) => {
    const difference = value(right) - value(left)
    if (difference !== 0) return descending ? difference : -difference
    return statementOrder(left, right)
  })
}

/// The tallest bar in a series, so a caller can scale it without dividing by
/// zero on an idle window.
export function sqlSeriesPeak(series: SqlBucket[], key: "statements" | "p95_us" = "statements"): number {
  return Math.max(1, ...series.map((bucket) => bucket[key] ?? 0))
}

/// Latency of one statement, with the same honesty as the route audit: a value
/// below a millisecond is reported as such instead of rounding to "0 ms".
export const formatStatementLatency = formatLatency
