import { expect, test, type Page } from "@playwright/test"

async function fixture(page: Page) {
  const state = {
    features: { thread_id_header: false, session_id_header: false },
    accessGate: Promise.resolve(),
    failAccess: false,
    failFeatureSave: false,
    calls: [] as { path: string; session: string; method: string; body: unknown }[],
  }
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const session = request.headers()["x-fixture-session"]
    const method = request.method()
    const body = method === "PUT" ? request.postDataJSON() : null
    state.calls.push({ path, session, method, body })
    if (path === "/api/me") {
      await state.accessGate
      return route.fulfill(state.failAccess ? { status: 500, json: { error: "Access check unavailable" } } : { json: { is_admin: session === "admin" } })
    }
    if (session !== "admin") return route.fulfill({ status: 403, json: { error: "Administrator access is required" } })
    if (path === "/api/experimental-features") {
      if (method === "PUT") {
        if (state.failFeatureSave) return route.fulfill({ status: 500, json: { error: "Feature save unavailable" } })
        state.features = { ...state.features, ...body }
      }
      return route.fulfill({ json: state.features })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  return state
}

const url = "/e2e/system-configuration.html#/admin/configuration"

test("a direct non-admin visit waits for identity and never fetches system settings", async ({ page }) => {
  const state = await fixture(page)
  let release!: () => void
  state.accessGate = new Promise<void>((resolve) => { release = resolve })
  await page.goto("/e2e/system-configuration.html?session=user#/admin/configuration")
  await expect(page.getByText("正在确认管理员权限…")).toBeVisible()
  await expect(page.getByRole("switch")).toHaveCount(0)
  await expect.poll(() => state.calls.length).toBeGreaterThan(0)
  expect(state.calls.every((call) => call.path === "/api/me")).toBe(true)
  release()
  await expect(page.getByText("仅管理员可查看和修改系统配置。")).toBeVisible()
  expect(state.calls.every((call) => call.path === "/api/me")).toBe(true)
})

test("the administrator page exposes only experimental controls, which save and survive refresh", async ({ page }) => {
  const state = await fixture(page)
  await page.goto(url)
  await expect(page.getByRole("switch")).toHaveCount(2)
  await expect(page.getByLabel("User-Agent", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "保存请求头", exact: true })).toHaveCount(0)
  const labels = ["发送 Thread ID 请求头", "发送 Session ID 请求头"]
  for (const label of labels) {
    const control = page.getByRole("switch", { name: label, exact: true })
    await control.click()
    await expect(control).toBeChecked()
  }
  expect(state.calls.filter((call) => call.method === "PUT").every((call) => call.path === "/api/experimental-features")).toBe(true)
  await page.reload()
  for (const label of labels) await expect(page.getByRole("switch", { name: label, exact: true })).toBeChecked()
})

test("access and save failures expose recovery without false success", async ({ page }) => {
  const state = await fixture(page)
  state.failAccess = true
  await page.goto(url)
  await expect(page.getByText("无法确认管理员权限", { exact: true })).toBeVisible()
  expect(state.calls.every((call) => call.path === "/api/me")).toBe(true)
  state.failAccess = false
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByRole("switch")).toHaveCount(2)
  state.failFeatureSave = true
  const control = page.getByRole("switch", { name: "发送 Thread ID 请求头", exact: true })
  await control.click()
  await expect(page.getByText("无法保存实验性功能设置")).toBeVisible()
  await expect(control).not.toBeChecked()
  state.failFeatureSave = false
  await control.click()
  await expect(control).toBeChecked()
})

test("switching accounts cannot display cached administrator controls", async ({ page }) => {
  const state = await fixture(page)
  await page.goto(url)
  await expect(page.getByRole("switch")).toHaveCount(2)
  await page.getByRole("button", { name: "Ordinary user", exact: true }).click()
  await expect(page.getByText("仅管理员可查看和修改系统配置。")).toBeVisible()
  await expect(page.getByRole("switch")).toHaveCount(0)
  expect(state.calls.filter((call) => call.session === "user").every((call) => call.path === "/api/me")).toBe(true)
  await page.getByRole("button", { name: "Administrator", exact: true }).click()
  await expect(page.getByRole("switch")).toHaveCount(2)
})

test("bilingual system controls remain usable in dark mode and narrow layouts", async ({ page }) => {
  await fixture(page)
  await page.goto(url)
  await expect(page.getByRole("switch")).toHaveCount(2)
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("switch", { name: "Send Thread ID header", exact: true })).toBeVisible()
  await page.screenshot({ path: "test-results/system-configuration-mobile.png", fullPage: true })
})
