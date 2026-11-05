export type RoutePerformanceWindow = "1h" | "6h" | "24h" | "7d"

export type RoutePerformanceStatus = { status: number; requests: number }

export type RoutePerformanceRoute = {
  route: string
  method: string
  requests: number
  total_us: number
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
  total_us: number
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

/// A cumulative duration: how much time a route or a window consumed, at the
/// scale an operator reads it in. Seconds keep a decimal because a cumulative
/// second is a real number; hours and days do not, because they are not.
export function formatTotalDuration(micros: number, language: "en" | "zh"): string {
  const zh = language === "zh"
  const seconds = Math.max(0, micros) / 1_000_000
  if (seconds < 1) return zh ? "不足 1 秒" : "<1 s"
  const whole = Math.floor(seconds)
  const days = Math.floor(whole / 86400)
  const hours = Math.floor(whole / 3600) % 24
  const minutes = Math.floor(whole / 60) % 60
  const remainder = Math.round(seconds - Math.floor(seconds / 60) * 60)
  if (days > 0) return zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`
  if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`
  if (minutes > 0) return zh ? `${minutes} 分 ${remainder} 秒` : `${minutes}m ${remainder}s`
  const value = seconds < 10 ? Number(seconds.toFixed(1)) : Math.round(seconds)
  return zh ? `${value} 秒` : `${value}s`
}

/// Where a request came from, read off the route the router matched: the
/// device protocol, the integration API, or everything the browser and an API
/// key talk to.
export type RouteSource = "browser" | "integration" | "worker"

export const routeSources: RouteSource[] = ["browser", "integration", "worker"]

export function routeSource(route: string): RouteSource {
  if (route.startsWith("/worker/")) return "worker"
  if (route.startsWith("/v1/")) return "integration"
  return "browser"
}

export type RouteSourceSummary = { source: RouteSource; requests: number; total_us: number; routes: number }

/// How much of the window each source accounts for. Device polling is traffic
/// like any other, so it is reported rather than hidden.
export function summarizeSources(routes: RoutePerformanceRoute[]): RouteSourceSummary[] {
  const summaries = new Map<RouteSource, RouteSourceSummary>(
    routeSources.map((source) => [source, { source, requests: 0, total_us: 0, routes: 0 }]),
  )
  for (const route of routes) {
    const summary = summaries.get(routeSource(route.route))!
    summary.requests += route.requests
    summary.total_us += route.total_us
    summary.routes += 1
  }
  return routeSources.map((source) => summaries.get(source)!)
}

/// The share of requests that failed, as a percentage; null when there is
/// nothing to take a share of.
export function errorRate(failures: number, requests: number): number | null {
  if (requests <= 0) return null
  return (failures / requests) * 100
}

export type RouteSortKey =
  | "requests"
  | "total_us"
  | "client_errors"
  | "server_errors"
  | "slow_requests"
  | "average_us"
  | "p95_us"
  | "max_us"

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
