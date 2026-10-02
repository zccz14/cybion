import { test, expect, type Page } from "@playwright/test"
const summary = (id: string, caller: string) => ({ id, caller_user_id: caller, has_details: true, worker_id: "worker", worker_label: "Mac", worker_hostname: null, worker_version: null, worker_resource: null, thread_id: `${id}-thread`, thread_title: `${id} private title`, input_record_id: 1, name: "bash", arguments: null, result: null, status: "completed", error: null, created_at: 1, started_at: 1, completed_at: 2 })
async function fixture(page: Page) {
  const details: { id: string; session: string }[] = []
  let failure = false
  let status = "completed"
  let detailResult: unknown = undefined
  let hold: Promise<void> | undefined
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const session = request.headers()["x-fixture-session"]
    const path = new URL(request.url()).pathname
    const uid = session === "other-session" ? "other-owner" : "stable-owner"
    if (path === "/api/me") return route.fulfill({ json: { user_id: uid } })
    if (path === "/api/workers") return route.fulfill({ json: [] })
    if (path === "/api/worker-calls") return route.fulfill({ json: { page: 1, page_size: 20, total: 2, items: [summary("own", uid), summary("foreign", "recipient")].map((item) => ({ ...item, status })) } })
    if (path.startsWith("/api/worker-calls/")) {
      const id = path.split("/").at(-1)!
      details.push({ id, session })
      await hold
      if (failure) return route.fulfill({ status: 503, json: { error: "Detail service unavailable" } })
      return route.fulfill({ json: { ...summary(id, uid), status, arguments: { command: `echo ${session}` }, result: detailResult === undefined ? { stdout: `result-${session}` } : detailResult, worker_resource: { cpu: 1 } } })
    }
    return route.fulfill({ status: 403, json: { error: "Unexpected endpoint" } })
  })
  return { details, status: (value: string) => { status = value }, result: (value: unknown) => { detailResult = value }, fail: (value: boolean) => { failure = value }, hold: (value: Promise<void> | undefined) => { hold = value } }
}

test("audit summaries preserve only own Thread links and load fresh details on expansion without cross-session leakage", async ({ page }) => {
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/worker-audit")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("link", { name: "own private title" })).toHaveAttribute("href", "#/threads/own-thread")
  await expect(page.getByRole("link", { name: "foreign private title" })).toHaveCount(0)
  await expect(page.getByText("foreign private title")).toHaveCount(0)
  const foreign = page.getByRole("row").filter({ hasText: "recipient" })
  await expect(foreign).toContainText("Private Thread")
  await expect(page.locator("pre")).toHaveCount(0)
  expect(state.details).toHaveLength(0)
  let release!: () => void
  state.hold(new Promise<void>((resolve) => { release = resolve }))
  await foreign.getByText("Arguments and result", { exact: true }).click()
  await expect(foreign.getByRole("status")).toHaveText("Loading details…")
  release()
  state.hold(undefined)
  await expect(foreign).toContainText("result-test-session")
  expect(state.details).toEqual([{ id: "foreign", session: "test-session" }])
  await foreign.getByText("Arguments and result", { exact: true }).click()
  await foreign.getByText("Arguments and result", { exact: true }).click()
  await expect(foreign).toContainText("result-test-session")
  await expect.poll(() => state.details.length).toBe(2)
  await page.getByRole("button", { name: "Switch account" }).click()
  await expect(page.locator("details[open]")).toHaveCount(0)
  await expect(page.getByText("result-test-session", { exact: false })).toHaveCount(0)
  await foreign.getByText("Arguments and result", { exact: true }).click()
  await expect(foreign).toContainText("result-other-session")
  expect(state.details).toEqual([{ id: "foreign", session: "test-session" }, { id: "foreign", session: "test-session" }, { id: "foreign", session: "other-session" }])
})

test("expanded detail shows network errors and retries only on explicit action", async ({ page }) => {
  const state = await fixture(page)
  state.fail(true)
  await page.goto("/e2e/fixture.html#/worker-audit")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const own = page.getByRole("row").filter({ has: page.getByRole("link", { name: "own private title" }) })
  await own.getByText("Arguments and result", { exact: true }).click()
  await expect(own.getByRole("alert")).toContainText("Detail service unavailable")
  expect(state.details).toHaveLength(1)
  state.fail(false)
  await own.getByRole("button", { name: "Retry" }).click()
  await expect(own).toContainText("result-test-session")
  expect(state.details).toHaveLength(2)
})


test("failed call details can refresh late results without a status change or page reload", async ({ page }) => {
  const state = await fixture(page)
  state.status("failed")
  state.result(null)
  await page.goto("/e2e/fixture.html#/worker-audit")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const own = page.getByRole("row").filter({ has: page.getByRole("link", { name: "own private title" }) })
  await own.getByText("Arguments and result", { exact: true }).click()
  await expect(own.locator("details pre").nth(1)).toHaveText("—")
  state.result({ stdout: "late-device-result" })
  await own.getByRole("button", { name: "Refresh details" }).click()
  await expect(own).toContainText("late-device-result")
  state.result({ stdout: "fresh-on-reopen" })
  await own.getByText("Arguments and result", { exact: true }).click()
  await own.getByText("Arguments and result", { exact: true }).click()
  await expect(own).toContainText("fresh-on-reopen")
  expect(state.details).toHaveLength(3)
})
