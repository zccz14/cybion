export type RoutePerformanceWindow = "1h" | "6h" | "24h" | "7d"

export type RoutePerformanceStatus = { status: number; requests: number }

export type RoutePerformanceRoute = {
  route: string
  method: string
  requests: number
  client_errors: number
  server_errors: number
  slow_requests: number
  average_us: number | null
  p50_us: number | null
  p95_us: number | null
  p99_us: number | null
  max_us: number | null
  statuses: RoutePerformanceStatus[]
}

export type RoutePerformanceTotals = {
  requests: number
  client_errors: number
  server_errors: number
  slow_requests: number
  average_us: number | null
  p50_us: number | null
  p95_us: number | null
  p99_us: number | null
  max_us: number | null
}

export type RoutePerformanceBucket = {
  bucket_start: number
  requests: number
  server_errors: number
  slow_requests: number
  p95_us: number | null
}

export type RoutePerformanceSlow = {
  sampled_at: number
  route: string
  method: string
  status: number
  latency_us: number
}

export type RoutePerformance = {
  window: RoutePerformanceWindow
  resolution: "minute" | "hour"
  bucket_seconds: number
  generated_at: number
  latest_bucket_start: number | null
  totals: RoutePerformanceTotals
  routes: RoutePerformanceRoute[]
  series: RoutePerformanceBucket[]
  slow: RoutePerformanceSlow[]
}

export const routePerformanceWindows: RoutePerformanceWindow[] = ["1h", "6h", "24h", "7d"]

/// A duration in microseconds, kept honest about what the audit knows: a value
/// below a millisecond is reported as such instead of rounding to "0 ms".
export function formatLatency(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return "—"
  const value = Math.max(0, micros)
  const trimmed = (scaled: number, digits: number) => Number(scaled.toFixed(digits))
  if (value < 1000) return `${Math.round(value)} µs`
  if (value < 10_000) return `${trimmed(value / 1000, 1)} ms`
  if (value < 1_000_000) return `${Math.round(value / 1000)} ms`
  if (value < 10_000_000) return `${trimmed(value / 1_000_000, 2)} s`
  return `${trimmed(value / 1_000_000, 1)} s`
}

/// The share of requests that failed, as a percentage; null when there is
/// nothing to take a share of.
export function errorRate(failures: number, requests: number): number | null {
  if (requests <= 0) return null
  return (failures / requests) * 100
}

export type RouteSortKey = "requests" | "client_errors" | "server_errors" | "slow_requests" | "average_us" | "p95_us" | "max_us"

const routeOrder = (left: RoutePerformanceRoute, right: RoutePerformanceRoute) =>
  left.route.localeCompare(right.route) || left.method.localeCompare(right.method)

/// Sorting a route table: the value asked for, largest first, and a stable
/// order underneath so equal rows never jump between renders.
export function sortRoutes(routes: RoutePerformanceRoute[], key: RouteSortKey, descending: boolean): RoutePerformanceRoute[] {
  const value = (route: RoutePerformanceRoute) => route[key] ?? -1
  return [...routes].sort((left, right) => {
    const difference = value(right) - value(left)
    if (difference !== 0) return descending ? difference : -difference
    return routeOrder(left, right)
  })
}

/// The tallest bar in a series, so a caller can scale it without dividing by
/// zero on an idle window.
export function seriesPeak(series: RoutePerformanceBucket[], key: "requests" | "p95_us" = "requests"): number {
  return Math.max(1, ...series.map((bucket) => bucket[key] ?? 0))
}
