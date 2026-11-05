import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  errorRate,
  formatLatency,
  seriesPeak,
  sortRoutes,
  type RoutePerformanceRoute,
} from "../src/lib/route-performance.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

const route = (overrides: Partial<RoutePerformanceRoute>): RoutePerformanceRoute => ({
  route: "/api/threads",
  method: "GET",
  requests: 10,
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

test("an error rate needs requests to take a share of", () => {
  assert.equal(errorRate(0, 0), null)
  assert.equal(errorRate(1, 0), null)
  assert.equal(errorRate(0, 40), 0)
  assert.equal(errorRate(1, 40), 2.5)
  assert.equal(errorRate(40, 40), 100)
})

test("sorting keeps the asked-for order and breaks ties by route", () => {
  const routes = [
    route({ route: "/b", requests: 5, p95_us: 9_000 }),
    route({ route: "/a", requests: 5, p95_us: 4_000 }),
    route({ route: "/c", requests: 50, p95_us: 1_000 }),
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
