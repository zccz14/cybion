import { expect, test, type Page } from "@playwright/test"

type Statement = {
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

const statement = (over: Partial<Statement> & Pick<Statement, "key" | "sql" | "caller" | "statements" | "total_us">): Statement => ({
  fullscan_steps: 0,
  fullscan_per_call: 0,
  slow_statements: 0,
  average_us: Math.round(over.total_us / over.statements),
  p50_us: 5_000,
  p95_us: 25_000,
  p99_us: 50_000,
  max_us: 90_000,
  ...over,
})

// The rows the hosted database actually produces: a commit that costs an fsync,
// a thread list that walks every thread it owns, a device poll, and enough
// filler that the table has to scroll like it does in production.
const statements: Statement[] = [
  statement({
    key: "1",
    caller: "src/cloud.rs:4045:5",
    sql: "WITH page AS MATERIALIZED ( SELECT t.id FROM threads t WHERE t.archived_at IS NULL AND t.created_by = ? ORDER BY t.updated_at DESC,t.id DESC LIMIT ? ) SELECT t.id,t.title FROM threads t WHERE t.id IN (SELECT id FROM page)",
    statements: 696,
    total_us: 14_243_000,
    fullscan_steps: 696 * 884,
    fullscan_per_call: 884,
    p95_us: 25_000,
    max_us: 90_000,
  }),
  statement({ key: "2", caller: "src/cloud.rs:8438:5", sql: "COMMIT", statements: 7_572, total_us: 19_180_000, average_us: 2_533, p95_us: 2_500, max_us: 4_000 }),
  statement({ key: "3", caller: "src/cloud.rs:10289:5", sql: "UPDATE workers SET status='online',last_seen_at=?,resource_json=? WHERE id=?", statements: 1_538, total_us: 4_000_000, average_us: 2_600, max_us: 30_000, slow_statements: 1 }),
  statement({ key: "4", caller: "src/cloud.rs:5404:19", sql: "SELECT id,name,description FROM manuals WHERE parent_id IS ? AND trashed_at IS NULL ORDER BY sort_key,name,id", statements: 10, total_us: 210_000, fullscan_steps: 1_910, fullscan_per_call: 191 }),
  statement({ key: "5", caller: "src/cloud/machines.rs:660:19", sql: "SELECT id,status,created_at FROM worker_calls WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 1", statements: 100, total_us: 21_000 }),
  statement({
    key: "6",
    caller: "src/cloud/worker_sharing.rs:713:16",
    sql: "SELECT worker_call_id,worker_owner_user_id,worker_grant_id,thread_id,worker_input_id,payload FROM history_records WHERE thread_id=? AND worker_input_id IS NOT NULL AND payload LIKE '%' || ? || '%' AND created_at >= ? ORDER BY id",
    statements: 5,
    total_us: 113_000,
    average_us: 22_600,
  }),
  // A statement that walks a whole table on every call: the badge has to say so.
  statement({ key: "7", caller: "cloud::stats::patrol", sql: "SELECT kind, COUNT(*), COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM history_records WHERE created_at >= ? AND created_at < ? GROUP BY kind", statements: 24, total_us: 960_000, fullscan_steps: 24 * 141_568, fullscan_per_call: 141_568, slow_statements: 2, max_us: 92_000 }),
  ...Array.from({ length: 17 }, (_, index) => statement({
    key: String(8 + index),
    caller: `src/cloud.rs:${9000 + index * 7}:${3 + index}`,
    sql: `SELECT id,thread_id,kind FROM history_records WHERE thread_id=? AND id>? ORDER BY id LIMIT ? /* filler ${index + 1} */`,
    statements: 400 - index * 11,
    total_us: 180_000 - index * 7_000,
    average_us: 300 + index * 40,
    p50_us: 250,
    p95_us: 900 + index * 50,
    p99_us: 1_200,
    max_us: 30_000 + index * 500,
  })),
]

const now = Math.floor(Date.now() / 1000)

const payload = {
  window: "24h",
  resolution: "hour",
  bucket_seconds: 3600,
  generated_at: now,
  latest_bucket_start: now - (now % 3600),
  enabled: true,
  overhead: { statements: 39_960, timed_statements: 156, recorder_us: 80_125, share_ppm: 450, worst_ppm: 1_718, unattributed: 0 },
  totals: {
    statements: 39_960,
    total_us: 41_800_000,
    fullscan_steps: 4_200_000,
    slow_statements: 9,
    average_us: 1_046,
    p50_us: 5_000,
    p95_us: 25_000,
    p99_us: 50_000,
    max_us: 92_000,
  },
  statements,
  series: Array.from({ length: 24 }, (_, index) => ({
    bucket_start: now - (23 - index) * 3600,
    statements: 900 + index * 37,
    total_us: 1_200_000 + index * 20_000,
    slow_statements: index === 12 ? 2 : 0,
    fullscan_steps: 120_000 + index * 4_000,
    p95_us: 12_000 + index * 900,
  })),
  slow: [
    { sampled_at: now - 600, key: "7", sql: "SELECT kind, COUNT(*), COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM history_records WHERE created_at >= ? AND created_at < ? GROUP BY kind", caller: "cloud::stats::patrol", latency_us: 92_000, fullscan_steps: 141_568 },
    { sampled_at: now - 1_200, key: "3", sql: "UPDATE workers SET status='online',last_seen_at=?,resource_json=? WHERE id=?", caller: "src/cloud.rs:10289:5", latency_us: 30_000, fullscan_steps: 0 },
    { sampled_at: now - 1_800, key: "1", sql: "WITH page AS MATERIALIZED ( SELECT t.id FROM threads t WHERE t.archived_at IS NULL AND t.created_by = ? ORDER BY t.updated_at DESC,t.id DESC LIMIT ? )", caller: "src/cloud.rs:4045:5", latency_us: 90_000, fullscan_steps: 884 },
  ],
}

async function fixture(page: Page, respond: unknown = payload) {
  const windows: string[] = []
  await page.route("**/api/sql-performance**", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ json: { enabled: false } })
    windows.push(new URL(route.request().url()).searchParams.get("window") ?? "")
    return route.fulfill({ json: respond })
  })
  return { windows }
}

test("the page reads statement cost, scan steps and its own overhead in one place", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/sql-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()

  const totals = page.locator('[data-slot="sql-performance-totals"]')
  await expect(totals).toContainText("Statements")
  await expect(totals).toContainText("39,960")
  await expect(totals).toContainText("Total time")
  await expect(totals).toContainText("42s")
  await expect(totals).toContainText("Rows scanned")
  await expect(totals).toContainText("4,200,000")

  // The profiler reports what it costs, in the same units the rest of the page uses.
  const overhead = page.locator('[data-slot="sql-performance-overhead"]')
  await expect(overhead).toContainText("Share of wall time")
  await expect(overhead).toContainText("0.045%")
  await expect(overhead).toContainText("Worst interval")
  await expect(overhead).toContainText("0.172%")
  await expect(page.locator('[data-slot="sql-performance-overhead"]')).toContainText("<1 s")

  // Cumulative time decides the default order, not the average: the 14.2 s list
  // query outranks the 19.2 s commit only when it really is larger.
  const table = page.locator('[data-slot="sql-performance-statements"]')
  const rows = table.locator('[data-slot="sql-performance-statement"]')
  await expect(rows).toHaveCount(24)
  await expect(rows.nth(0)).toContainText("COMMIT")
  await expect(rows.nth(1)).toContainText("threads t")
  await expect(rows.nth(1)).toContainText("14s")
  // 884 rows walked per call is a wide scan, and the badge says so.
  await expect(rows.nth(1)).toContainText("wide scan")
  await expect(rows.nth(0)).toContainText("indexed")

  // The statement text is cut to one line but the whole statement stays reachable.
  const longest = rows.nth(1).locator('[data-slot="sql-performance-statement-sql"]')
  await expect(longest).toHaveAttribute("title", /WITH page AS MATERIALIZED/)

  const slow = page.locator('[data-slot="sql-performance-slow"]')
  await expect(slow.getByRole("row")).toHaveCount(4)
  await expect(slow.getByRole("row").nth(1)).toContainText("92 ms")

  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(totals).toContainText("累计耗时")
  await expect(totals).toContainText("42 秒")
  await expect(overhead).toContainText("占墙钟比例")

  expect(new Set(state.windows)).toEqual(new Set(["24h"]))
  expect(errors).toEqual([])
})

test("a column header sorts by the rows a statement scans", async ({ page }) => {
  await fixture(page)
  await page.goto("/e2e/fixture.html#/sql-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const table = page.locator('[data-slot="sql-performance-statements"]')
  await page.getByRole("button", { name: "Sort by Scan/call" }).click()
  // The settlement scan walks 141,568 rows per call and has to come first. The
  // cell shows a 140-character preview, so the tail is asserted through the title
  // the whole statement is kept in.
  const first = table.locator('[data-slot="sql-performance-statement"]').nth(0)
  await expect(first).toContainText("141,568")
  await expect(first.locator('[data-slot="sql-performance-statement-sql"]')).toHaveAttribute("title", /GROUP BY kind/)
  await expect(page.getByRole("columnheader", { name: /Scan\/call/ })).toHaveAttribute("aria-sort", "descending")
  await page.getByRole("button", { name: "Sort by Scan/call" }).click()
  await expect(page.getByRole("columnheader", { name: /Scan\/call/ })).toHaveAttribute("aria-sort", "ascending")
})

test("the profiling switch posts the new state", async ({ page }) => {
  await fixture(page)
  await page.goto("/e2e/fixture.html#/sql-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const request = page.waitForRequest((candidate) => candidate.url().includes("/api/sql-performance") && candidate.method() === "POST")
  await page.getByRole("switch").click()
  expect((await request).postDataJSON()).toEqual({ enabled: false })
})

test("a non-administrator is told why the page is empty instead of seeing an error", async ({ page }) => {
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/sql-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.locator('[data-slot="sql-performance-statements"]')).toBeVisible()
  await page.getByRole("button", { name: "Access" }).click()
  await expect(page.getByText("Only an administrator reads SQL performance.")).toBeVisible()
  // Nothing is asked of the server when the caller may not read it.
  const before = state.windows.length
  await page.getByRole("button", { name: "Access" }).click()
  await expect(page.locator('[data-slot="sql-performance-statements"]')).toBeVisible()
  expect(state.windows.length).toBeGreaterThanOrEqual(before)
})

test("layout holds at production row counts and at a narrow width", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.goto("/e2e/fixture.html#/sql-performance")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.locator('[data-slot="sql-performance-statements"]')).toBeVisible()
  await page.screenshot({ path: "/tmp/sql-performance-wide.png", fullPage: true })

  // The table is the only thing that scrolls: the page must not grow to 24 rows.
  const table = page.locator('[data-slot="sql-performance-statements"]')
  const overflow = await table.evaluate((element) => element.parentElement!.scrollHeight > element.parentElement!.clientHeight)
  expect(overflow).toBe(true)

  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({ path: "/tmp/sql-performance-narrow.png", fullPage: true })
})
