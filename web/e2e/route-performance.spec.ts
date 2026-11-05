import { expect, test, type Page } from "@playwright/test"

type Route = {
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
  statuses: { status: number; requests: number }[]
}

const bucket = (bucket_start: number, requests: number, p95_us: number | null, server_errors = 0) => ({
  bucket_start,
  requests,
  server_errors,
  slow_requests: 0,
  p95_us,
})

// Four routes, one per corner of the page: a fast browser route, a slow one, a
// device worker poll and an integration call.
const routes: Route[] = [
  {
    route: "/api/threads",
    method: "GET",
    requests: 120,
    total_us: 1_200_000,
    client_errors: 0,
    server_errors: 0,
    slow_requests: 0,
    average_us: 10_000,
    p50_us: 5_000,
    p95_us: 25_000,
    p99_us: 50_000,
    max_us: 90_000,
    statuses: [{ status: 200, requests: 120 }],
  },
  {
    route: "/worker/v1/users/{user_id}/workers/{worker_id}/calls",
    method: "POST",
    requests: 84,
    total_us: 12_000_000,
    client_errors: 0,
    server_errors: 1,
    slow_requests: 2,
    average_us: 142_000,
    p50_us: 100_000,
    p95_us: 1_000_000,
    p99_us: 2_500_000,
    max_us: 3_100_000,
    statuses: [{ status: 200, requests: 83 }, { status: 502, requests: 1 }],
  },
  {
    route: "/api/threads/{id}/inputs",
    method: "POST",
    requests: 30,
    total_us: 45_000_000,
    client_errors: 2,
    server_errors: 3,
    slow_requests: 4,
    average_us: 1_500_000,
    p50_us: 500_000,
    p95_us: 5_000_000,
    p99_us: 30_000_000,
    max_us: 41_000_000,
    statuses: [
      { status: 200, requests: 25 },
      { status: 500, requests: 3 },
      { status: 400, requests: 2 },
    ],
  },
  {
    route: "/v1/threads",
    method: "POST",
    requests: 3,
    total_us: 60_000,
    client_errors: 0,
    server_errors: 0,
    slow_requests: 0,
    average_us: 20_000,
    p50_us: 10_000,
    p95_us: 10_000,
    p99_us: 25_000,
    max_us: 25_000,
    statuses: [{ status: 201, requests: 3 }],
  },
]

function payload(window: string) {
  const minute = window === "1h" || window === "6h"
  return {
    window,
    resolution: minute ? "minute" : "hour",
    bucket_seconds: minute ? 60 : 3600,
    generated_at: 1_700_000_000,
    latest_bucket_start: 1_699_999_800,
    totals: {
      requests: 237,
      total_us: 58_260_000,
      client_errors: 2,
      server_errors: 4,
      slow_requests: 6,
      average_us: 245_000,
      p50_us: 5_000,
      p95_us: 2_500_000,
      p99_us: 30_000_000,
      max_us: 41_000_000,
    },
    routes,
    series: [
      bucket(1_699_992_000, 40, 25_000),
      bucket(1_699_995_600, 22, 500_000, 1),
      bucket(1_699_999_200, 100, 2_500_000, 2),
    ],
    slow: [
      { sampled_at: 1_699_999_500, route: "/api/threads/{id}/inputs", method: "POST", status: 500, latency_us: 41_000_000 },
      { sampled_at: 1_699_999_400, route: "/api/threads/{id}/inputs", method: "POST", status: 200, latency_us: 5_400_000 },
    ],
  }
}

const empty = (window: string) => ({
  ...payload(window),
  totals: { requests: 0, total_us: 0, client_errors: 0, server_errors: 0, slow_requests: 0, average_us: null, p50_us: null, p95_us: null, p99_us: null, max_us: null },
  routes: [],
  series: [],
  slow: [],
})

async function fixture(page: Page, respond: (window: string) => unknown = payload) {
  const windows: string[] = []
  await page.route("**/api/route-performance**", async (route) => {
    const window = new URL(route.request().url()).searchParams.get("window") ?? ""
    windows.push(window)
    return route.fulfill({ json: respond(window) })
  })
  return { windows }
}

test("the page reads every route's requests, cumulative time and outcomes in one table", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()

  const totals = page.locator('[data-slot="route-performance-totals"]')
  await expect(totals).toContainText("Requests")
  await expect(totals).toContainText("237")
  // 58.26 s of answering in the window, read as a duration rather than a number.
  await expect(totals).toContainText("Total time")
  await expect(totals).toContainText("58s")
  await expect(totals).toContainText("1.7%")

  const table = page.locator('[data-slot="route-performance-routes"]')
  await expect(table.getByRole("row")).toHaveCount(5)
  // Requests decide the default order.
  const threads = table.getByRole("row").nth(1)
  await expect(threads).toContainText("/api/threads")
  await expect(threads).toContainText("120")
  await expect(threads).toContainText("1.2s")
  await expect(table.getByRole("row").nth(2)).toContainText("worker_id")
  const inputs = table.getByRole("row").nth(3)
  await expect(inputs).toContainText("/api/threads/{id}/inputs")
  await expect(inputs).toContainText("45s")
  await expect(inputs).toContainText("41 s")
  // A 5xx is called out, and a route that never failed reads as a dash.
  await expect(inputs.getByRole("cell", { name: "3", exact: true })).toHaveClass(/text-destructive/)
  await expect(table.getByRole("row").nth(4).getByRole("cell", { name: "—", exact: true })).toHaveCount(3)

  // Device polling is traffic too: it is reported per source instead of hidden.
  const sources = page.locator('[data-slot="route-performance-sources"]')
  await expect(sources).toContainText("Browser and API keys")
  await expect(sources).toContainText("150")
  await expect(sources).toContainText("46s")
  await expect(sources).toContainText("Integration API")
  await expect(sources).toContainText("Device workers")
  await expect(sources).toContainText("84")
  await expect(sources).toContainText("12s")

  const slow = page.locator('[data-slot="route-performance-slow"]')
  await expect(slow.getByRole("row")).toHaveCount(3)
  await expect(slow.getByRole("row").nth(1)).toContainText("41 s")

  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(totals).toContainText("累计耗时")
  await expect(totals).toContainText("58 秒")
  await expect(sources).toContainText("设备 Worker")

  // The window asks for 24 hours until the operator changes it.
  expect(state.windows.length).toBeGreaterThan(0)
  expect(new Set(state.windows)).toEqual(new Set(["24h"]))
  expect(errors).toEqual([])
})

test("a column header sorts the table and the arrow follows the direction", async ({ page }) => {
  await fixture(page)
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const table = page.locator('[data-slot="route-performance-routes"]')
  await page.getByRole("button", { name: "Sort by P95" }).click()
  await expect(table.getByRole("row").nth(1)).toContainText("/api/threads/{id}/inputs")
  await expect(page.getByRole("columnheader", { name: /P95/ })).toHaveAttribute("aria-sort", "descending")
  await page.getByRole("button", { name: "Sort by P95" }).click()
  await expect(table.getByRole("row").nth(1)).toContainText("/v1/threads")
  await expect(page.getByRole("columnheader", { name: /P95/ })).toHaveAttribute("aria-sort", "ascending")
  // Cumulative time sorts on its own column, not on the average.
  await page.getByRole("button", { name: "Sort by Total time" }).click()
  await expect(table.getByRole("row").nth(1)).toContainText("/api/threads/{id}/inputs")
  await page.getByRole("button", { name: "Sort by Total time" }).click()
  await expect(table.getByRole("row").nth(1)).toContainText("/v1/threads")
})

test("the window switch asks for the new range and names its bucket", async ({ page }) => {
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByText("per hour")).toBeVisible()
  await page.getByRole("combobox", { name: "Window" }).click()
  await page.getByRole("option", { name: "Last hour" }).click()
  await expect(page.getByText("per minute")).toBeVisible()
  await expect(page.getByText("Requests served each minute of the window")).toBeVisible()
  await expect.poll(() => state.windows.at(-1)).toBe("1h")
})

test("an empty window and a rejected read each say what happened", async ({ page }) => {
  await fixture(page, (window) => empty(window))
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByText("No request has been recorded in this window yet.").first()).toBeVisible()
  await expect(page.getByText("Nothing at or above 1 s in this window.")).toBeVisible()

  await page.unroute("**/api/route-performance**")
  await page.route("**/api/route-performance**", (route) => route.fulfill({ status: 403, json: { error: "administrator access is required" } }))
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByRole("alert")).toContainText("administrator access is required")
})

test("the page reflows without horizontal overflow at phone width in both themes", async ({ page }) => {
  await fixture(page)
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme" }).click()
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
})
