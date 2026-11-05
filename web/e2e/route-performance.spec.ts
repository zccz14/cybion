import { expect, test, type Page } from "@playwright/test"

type Route = {
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
  statuses: { status: number; requests: number }[]
}

const bucket = (bucket_start: number, requests: number, p95_us: number | null, server_errors = 0) => ({
  bucket_start,
  requests,
  server_errors,
  slow_requests: 0,
  p95_us,
})

const routes: Route[] = [
  {
    route: "/api/threads",
    method: "GET",
    requests: 120,
    client_errors: 0,
    server_errors: 0,
    slow_requests: 0,
    average_us: 8_000,
    p50_us: 5_000,
    p95_us: 25_000,
    p99_us: 50_000,
    max_us: 90_000,
    statuses: [{ status: 200, requests: 120 }],
  },
  {
    route: "/api/threads/{id}/inputs",
    method: "POST",
    requests: 30,
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
    route: "/api/worker-calls",
    method: "GET",
    requests: 12,
    client_errors: 0,
    server_errors: 0,
    slow_requests: 0,
    average_us: 2_000,
    p50_us: 2_000,
    p95_us: 5_000,
    p99_us: 10_000,
    max_us: 12_000,
    statuses: [{ status: 200, requests: 12 }],
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
      requests: 162,
      client_errors: 2,
      server_errors: 3,
      slow_requests: 4,
      average_us: 300_000,
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
  totals: { requests: 0, client_errors: 0, server_errors: 0, slow_requests: 0, average_us: null, p50_us: null, p95_us: null, p99_us: null, max_us: null },
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

test("the page reads every route's requests, percentiles and outcomes in one table", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/route-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()

  const totals = page.locator('[data-slot="route-performance-totals"]')
  await expect(totals).toContainText("Requests")
  await expect(totals).toContainText("162")
  await expect(totals).toContainText("1.9%")
  await expect(totals).toContainText("2.5 s")
  await expect(totals).toContainText("41 s")

  const table = page.locator('[data-slot="route-performance-routes"]')
  await expect(table.getByRole("row")).toHaveCount(4)
  // Requests decide the default order.
  await expect(table.getByRole("row").nth(1)).toContainText("/api/threads")
  await expect(table.getByRole("row").nth(1)).toContainText("120")
  const inputs = table.getByRole("row").nth(2)
  await expect(inputs).toContainText("/api/threads/{id}/inputs")
  await expect(inputs).toContainText("41 s")
  // A 5xx is called out, and a route that never failed reads as a dash rather
  // than a zero.
  await expect(inputs.getByRole("cell", { name: "3", exact: true })).toHaveClass(/text-destructive/)
  await expect(table.getByRole("row").nth(3)).toContainText("/api/worker-calls")
  await expect(table.getByRole("row").nth(3).getByRole("cell", { name: "—", exact: true })).toHaveCount(3)

  const slow = page.locator('[data-slot="route-performance-slow"]')
  await expect(slow.getByRole("row")).toHaveCount(3)
  await expect(slow.getByRole("row").nth(1)).toContainText("41 s")

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
  await expect(table.getByRole("row").nth(1)).toContainText("/api/worker-calls")
  await expect(page.getByRole("columnheader", { name: /P95/ })).toHaveAttribute("aria-sort", "ascending")
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
