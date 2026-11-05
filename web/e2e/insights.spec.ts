import { expect, test, type Page } from "@playwright/test"

const account = {
  metrics: {
    requests: 1234,
    input_tokens: 5_000_000,
    output_tokens: 2_000_000,
    total_tokens: 7_000_000,
    cached_tokens: 1_500_000,
    cache_hit_rate: 0.3,
    history_records: 9876,
    threads: 42,
    workers: 3,
    running: { total: 5, kernel: 2, inference: 2, device: 1, unattended: 1, longest_seconds: 754 },
    sqlite_bytes: 12 * 1024 * 1024,
    sqlite_main_bytes: 10 * 1024 * 1024,
    sqlite_wal_bytes: 1536 * 1024,
    sqlite_shm_bytes: 512 * 1024,
  },
  traffic: {
    worker_received_bytes: 1024 * 1024,
    worker_sent_bytes: 2048,
    upstream_received_bytes: 5 * 1024 * 1024,
    upstream_sent_bytes: 300_000,
  },
}

// A range changes the snapshot sections and only them: the account block is the
// same lifetime total whatever the filter says.
const payload = (range: string) => ({
  range,
  generated_at: 1_700_000_000,
  backfilling: false,
  activity: {
    timezone: "UTC",
    days: [{ date: "2023-11-14", active_threads: 2, activity_records: 10, input_records: 3, requests: 4, total_tokens: 120 }],
  },
  tokens: {
    completed_requests: range === "24h" ? 3 : 34,
    input_tokens: range === "24h" ? 900 : 100_000,
    output_tokens: range === "24h" ? 400 : 40_000,
    total_tokens: range === "24h" ? 1300 : 140_000,
    cached_tokens: range === "24h" ? 200 : 25_000,
    cache_hit_rate: 25,
    input_output_ratio: 2.5,
  },
  requests: {
    total: range === "24h" ? 4 : 40,
    completed: range === "24h" ? 3 : 34,
    in_flight: range === "24h" ? 0 : 2,
    failed: range === "24h" ? 1 : 3,
    cancelled: 0,
  },
  by_model: [
    {
      model: "gpt-5.2",
      reasoning_effort: "high",
      calls: 30,
      completed: 26,
      in_flight: 2,
      failed: 2,
      cancelled: 0,
      input_tokens: 90_000,
      output_tokens: 36_000,
      total_tokens: 126_000,
      cached_tokens: 22_000,
      cache_hit_rate: 24.4,
      input_output_ratio: 2.5,
      duration_seconds: 3600,
      average_duration_seconds: 120,
    },
  ],
  worker: {
    calls: 12,
    read_bytes: 2048,
    write_bytes: 4096,
    duration_seconds: 600,
    average_duration_seconds: 50,
    by_worker: [
      { worker_id: "worker-1", worker_label: "Laptop", calls: 12, read_bytes: 2048, write_bytes: 4096, duration_seconds: 600, average_duration_seconds: 50 },
    ],
  },
  history: { total_records: 321, payload_bytes: 1_048_576, checkpoint_count: 4, latest_record_at: 1_699_999_000 },
  dimensions: { models: ["gpt-5.2", "o4"], request_kinds: ["inference", "compaction"] },
  account,
})

async function fixture(page: Page) {
  const ranges: string[] = []
  await page.route("**/api/insights**", async (route) => {
    const range = new URL(route.request().url()).searchParams.get("range") ?? ""
    ranges.push(range)
    return route.fulfill({ json: payload(range) })
  })
  return { ranges }
}

test("request outcomes and Worker calls stack in two full-width rows", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/e2e/fixture.html#/insights")
  await page.getByRole("button", { name: "Language", exact: true }).click()

  const requests = page.locator('[data-slot="insight-requests"]')
  const worker = page.locator('[data-slot="insight-worker"]')
  await expect(requests).toContainText("Request outcomes")
  await expect(worker).toContainText("Worker calls")
  const a = await requests.boundingBox()
  const b = await worker.boundingBox()
  expect(a && b).toBeTruthy()
  // Two rows, not one split row: the Worker card starts below the outcomes
  // card and both span the content width instead of half of it.
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1)
  expect(Math.abs(a!.width - b!.width)).toBeLessThan(2)
  expect(a!.width).toBeGreaterThan(900)
  await expect(worker.getByRole("row")).toHaveCount(2)
})

test("the account block carries the administrator page's numbers and definitions", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await fixture(page)
  await page.goto("/e2e/fixture.html#/insights")
  await page.getByRole("button", { name: "Language", exact: true }).click()

  const block = page.locator('[data-slot="insight-account"]')
  await expect(block).toContainText("Account totals")
  await expect(block).toContainText("1,234")
  await expect(block).toContainText("7,000,000")
  await expect(block).toContainText("Input 5,000,000")
  await expect(block).toContainText("Output 2,000,000")
  // The account block reports a ratio where the range sections report a
  // percentage; both read as one percent figure.
  await expect(block).toContainText("30%")
  await expect(block).toContainText("Cached input 1,500,000")
  await expect(block).toContainText("9,876")
  await expect(block).toContainText("42")
  await expect(block).toContainText("Kernel 2 · Inference 2 · Device 1")
  await expect(block).toContainText("Longest 12m 34s")
  await expect(block.getByRole("status")).toContainText("1 unattended")
  // A label sits in its own cell, so read the value beside it.
  await expect(block.getByText("SQLite", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("12 MB")
  await expect(block).toContainText("DB 10 MB · WAL 1.5 MB · SHM 512 KB")
  await expect(block.getByText("Workers", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("3")
  await expect(block.getByLabel("Sent 2.0 KB")).toBeVisible()
  await expect(block.getByLabel("Received 1.0 MB")).toBeVisible()
  await expect(block.getByLabel("Sent 293 KB")).toBeVisible()
  await expect(block.getByLabel("Received 5.0 MB")).toBeVisible()

  // The definitions are the administrator page's, word for word.
  await page.getByText("Metric definitions").click()
  await expect(page.getByText("The three always add up to the running total")).toBeVisible()
  await expect(page.getByText(/Account totals are all-time/).first()).toBeVisible()
  expect(errors).toEqual([])
})

test("the account block ignores the range while the snapshot sections follow it", async ({ page }) => {
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/insights")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const block = page.locator('[data-slot="insight-account"]')
  const requests = page.locator('[data-slot="insight-requests"]')
  await expect(block).toContainText("1,234")
  await expect(requests).toContainText("40")

  await page.getByRole("combobox", { name: "Time range" }).click()
  await page.getByRole("option", { name: "Last 24 hours" }).click()
  await expect.poll(() => state.ranges.at(-1)).toBe("24h")
  // The snapshot sections narrowed; the account's lifetime total did not move.
  await expect(requests).toContainText("4")
  await expect(block).toContainText("1,234")
  await expect(block).toContainText("7,000,000")
})

test("the page reflows without horizontal overflow at phone width in both themes", async ({ page }) => {
  await fixture(page)
  await page.goto("/e2e/fixture.html#/insights")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme" }).click()
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
})
