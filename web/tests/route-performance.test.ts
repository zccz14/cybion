import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  errorRate,
  formatLatency,
  formatTotalDuration,
  routeSource,
  seriesPeak,
  sortRoutes,
  summarizeSources,
  type RoutePerformanceRoute,
} from "../src/lib/route-performance.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

const route = (overrides: Partial<RoutePerformanceRoute>): RoutePerformanceRoute => ({
  route: "/api/threads",
  method: "GET",
  requests: 10,
  total_us: 10_000,
  client_errors: 0,
  server_errors: 0,
  slow_requests: 0,
  average_us: 1_000,
  p50_us: 1_000,
  p95_us: 2_000,
  p99_us: 3_000,
  max_us: 4_000,
  statuses: [{ status: 200, requests: 10 }],
  ...overrides,
})

test("a duration is reported in the unit that keeps it readable", () => {
  assert.equal(formatLatency(null), "—")
  assert.equal(formatLatency(0), "0 µs")
  assert.equal(formatLatency(420), "420 µs")
  assert.equal(formatLatency(1_500), "1.5 ms")
  assert.equal(formatLatency(43_000), "43 ms")
  assert.equal(formatLatency(950_000), "950 ms")
  assert.equal(formatLatency(1_240_000), "1.24 s")
  assert.equal(formatLatency(12_400_000), "12.4 s")
})

test("a cumulative duration is reported at the scale it is read in", () => {
  assert.equal(formatTotalDuration(0, "zh"), "不足 1 秒")
  assert.equal(formatTotalDuration(900_000, "en"), "<1 s")
  assert.equal(formatTotalDuration(1_500_000, "zh"), "1.5 秒")
  assert.equal(formatTotalDuration(1_500_000, "en"), "1.5s")
  assert.equal(formatTotalDuration(42_000_000, "zh"), "42 秒")
  assert.equal(formatTotalDuration(182_000_000, "zh"), "3 分 2 秒")
  assert.equal(formatTotalDuration(182_000_000, "en"), "3m 2s")
  assert.equal(formatTotalDuration(7_320_000_000, "zh"), "2 小时 2 分")
  assert.equal(formatTotalDuration(7_320_000_000, "en"), "2h 2m")
  assert.equal(formatTotalDuration(96_000_000_000, "zh"), "1 天 2 小时")
  assert.equal(formatTotalDuration(96_000_000_000, "en"), "1d 2h")
})

test("a route's source is read off the prefix the router matched", () => {
  assert.equal(routeSource("/api/threads"), "browser")
  assert.equal(routeSource("/api/route-performance"), "browser")
  assert.equal(routeSource("/v1/threads/{id}/inputs"), "integration")
  assert.equal(
    routeSource("/worker/v1/users/{user_id}/workers/{worker_id}/calls"),
    "worker",
  )
  const sources = summarizeSources([
    route({ route: "/api/threads", requests: 10, total_us: 10_000 }),
    route({ route: "/v1/threads", method: "POST", requests: 3, total_us: 300_000 }),
    route({ route: "/worker/v1/users/{user_id}/workers/{worker_id}/calls", method: "POST", requests: 90, total_us: 900_000 }),
  ])
  assert.deepEqual(sources, [
    { source: "browser", requests: 10, total_us: 10_000, routes: 1 },
    { source: "integration", requests: 3, total_us: 300_000, routes: 1 },
    { source: "worker", requests: 90, total_us: 900_000, routes: 1 },
  ])
  // Every source is reported even when it saw nothing, so the line is stable.
  assert.deepEqual(summarizeSources([]), [
    { source: "browser", requests: 0, total_us: 0, routes: 0 },
    { source: "integration", requests: 0, total_us: 0, routes: 0 },
    { source: "worker", requests: 0, total_us: 0, routes: 0 },
  ])
})

test("an error rate needs requests to take a share of", () => {
  assert.equal(errorRate(0, 0), null)
  assert.equal(errorRate(1, 0), null)
  assert.equal(errorRate(0, 40), 0)
  assert.equal(errorRate(1, 40), 2.5)
  assert.equal(errorRate(40, 40), 100)
})

test("sorting keeps the asked-for order and breaks ties by route", () => {
  const routes = [
    route({ route: "/b", requests: 5, p95_us: 9_000, total_us: 5_000 }),
    route({ route: "/a", requests: 5, p95_us: 4_000, total_us: 40_000 }),
    route({ route: "/c", requests: 50, p95_us: 1_000, total_us: 1_000 }),
  ]
  assert.deepEqual(
    sortRoutes(routes, "requests", true).map((item) => item.route),
    ["/c", "/a", "/b"],
  )
  assert.deepEqual(
    sortRoutes(routes, "requests", false).map((item) => item.route),
    ["/a", "/b", "/c"],
  )
  assert.deepEqual(
    sortRoutes(routes, "p95_us", true).map((item) => item.p95_us),
    [9_000, 4_000, 1_000],
  )
  assert.deepEqual(
    sortRoutes(routes, "total_us", true).map((item) => item.total_us),
    [40_000, 5_000, 1_000],
  )
  // A route that never reported a percentile sorts last, and the input array is
  // left alone.
  const missing = [route({ route: "/x", p95_us: null }), route({ route: "/y", p95_us: 5 })]
  assert.deepEqual(
    sortRoutes(missing, "p95_us", true).map((item) => item.route),
    ["/y", "/x"],
  )
  assert.equal(routes[0].route, "/b")
})

test("a peak is never zero, so an idle window still has a scale", () => {
  assert.equal(seriesPeak([]), 1)
  assert.equal(
    seriesPeak([
      { bucket_start: 1, requests: 0, server_errors: 0, slow_requests: 0, p95_us: null },
    ]),
    1,
  )
  assert.equal(
    seriesPeak([
      { bucket_start: 1, requests: 3, server_errors: 0, slow_requests: 0, p95_us: 700 },
      { bucket_start: 2, requests: 9, server_errors: 0, slow_requests: 0, p95_us: 100 },
    ]),
    9,
  )
  assert.equal(
    seriesPeak(
      [
        { bucket_start: 1, requests: 3, server_errors: 0, slow_requests: 0, p95_us: 700 },
        { bucket_start: 2, requests: 9, server_errors: 0, slow_requests: 0, p95_us: 100 },
      ],
      "p95_us",
    ),
    700,
  )
})

test("the page is wired as an administrator-only audit page", () => {
  assert.match(source, /routePerformance: "Interface performance"/)
  assert.match(source, /routePerformance: "接口性能"/)
  assert.match(source, /isAdmin \? \[\{ to: "\/route-performance", label: t\("routePerformance"\), icon: GaugeIcon \}\] : \[\]/)
  assert.match(source, /<Route path="\/route-performance" element=\{<RoutePerformancePage sdk=\{sdk\} \/>\} \/>/)
  assert.match(source, /if \(pathname\.startsWith\("\/route-performance"\)\) return t\("routePerformance"\)/)
  assert.match(source, /<RoutePerformance language=\{language\} sessionId=\{sdk\.session\.getState\(\)\.sessionId\}/)
})
