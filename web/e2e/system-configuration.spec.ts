import { expect, test, type Page } from "@playwright/test"

async function fixture(page: Page) {
  const state = {
    headers: { user_agent: "Existing/1.0", originator: "desktop" },
    features: { thread_id_header: false, session_id_header: false, codex_turn_state_header: false },
    accessGate: Promise.resolve(),
    headersGate: Promise.resolve(),
    saveGate: Promise.resolve(),
    failAccess: false,
    failHeadersLoad: false,
    failHeadersSave: false,
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
    if (path === "/api/integrations") {
      if (method === "PUT") {
        await state.saveGate
        if (state.failHeadersSave) return route.fulfill({ status: 403, json: { error: "Administrator access was revoked" } })
        state.headers = { user_agent: body.user_agent.trim(), originator: body.originator.trim() }
      } else {
        await state.headersGate
        if (state.failHeadersLoad) return route.fulfill({ status: 500, json: { error: "Headers unavailable" } })
      }
      return route.fulfill({ json: { ...state.headers, openai_consumer_id: "personal-consumer", openai_configured: true } })
    }
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
  await expect(page.getByLabel("User-Agent", { exact: true })).toHaveCount(0)
  expect(state.calls.every((call) => call.path === "/api/me")).toBe(true)
})

test("admin headers and all experimental controls save independently and survive refresh", async ({ page }) => {
  const state = await fixture(page)
  let release!: () => void
  state.headersGate = new Promise<void>((resolve) => { release = resolve })
  await page.goto(url)
  await expect(page.getByRole("switch")).toHaveCount(3)
  await expect(page.getByRole("button", { name: "保存请求头", exact: true })).toHaveCount(0)
  release()
  const userAgent = page.getByLabel("User-Agent", { exact: true })
  const originator = page.getByLabel("Originator", { exact: true })
  const save = page.getByRole("button", { name: "保存请求头", exact: true })
  await expect(userAgent).toHaveValue("Existing/1.0")
  await expect(save).toBeDisabled()
  await userAgent.fill("  Updated/2.0  ")
  await originator.fill("new-client")
  let finishSave!: () => void
  state.saveGate = new Promise<void>((resolve) => { finishSave = resolve })
  await save.click()
  await expect(userAgent).toBeDisabled()
  await expect(originator).toBeDisabled()
  finishSave()
  await expect(page.getByText("请求头已保存", { exact: true })).toBeVisible()
  await expect(userAgent).toHaveValue("Updated/2.0")
  await expect(save).toBeDisabled()
  expect(state.calls.find((call) => call.method === "PUT" && call.path === "/api/integrations")?.body).toEqual({ user_agent: "  Updated/2.0  ", originator: "new-client" })
  const labels = ["发送 Thread ID 请求头", "发送 Session ID 请求头", "回传 x-codex-turn-state 请求头"]
  for (const label of labels) {
    const control = page.getByRole("switch", { name: label, exact: true })
    await control.click()
    await expect(control).toBeChecked()
  }
  await page.reload()
  await expect(userAgent).toHaveValue("Updated/2.0")
  await expect(originator).toHaveValue("new-client")
  for (const label of labels) await expect(page.getByRole("switch", { name: label, exact: true })).toBeChecked()
})

test("access/load/save failures expose recovery without false success or lost drafts", async ({ page }) => {
  const state = await fixture(page)
  state.failAccess = true
  await page.goto(url)
  await expect(page.getByText("无法确认管理员权限", { exact: true })).toBeVisible()
  expect(state.calls.every((call) => call.path === "/api/me")).toBe(true)
  state.failAccess = false
  state.failHeadersLoad = true
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByText("Headers unavailable")).toBeVisible()
  await expect(page.getByLabel("User-Agent", { exact: true })).toHaveCount(0)
  state.failHeadersLoad = false
  await page.getByRole("button", { name: "重试", exact: true }).click()
  const input = page.getByLabel("User-Agent", { exact: true })
  await input.fill("Unsaved/3.0")
  await page.getByRole("button", { name: "Refetch", exact: true }).click()
  await expect(input).toHaveValue("Unsaved/3.0")
  state.failHeadersSave = true
  await page.getByRole("button", { name: "保存请求头", exact: true }).click()
  await expect(page.getByText("Administrator access was revoked")).toBeVisible()
  await expect(page.getByText("请求头已保存", { exact: true })).toHaveCount(0)
  await expect(input).toHaveValue("Unsaved/3.0")
  state.failHeadersSave = false
  await page.getByRole("button", { name: "保存请求头", exact: true }).click()
  await expect(page.getByText("请求头已保存", { exact: true })).toBeVisible()
  await input.fill("Next draft")
  await expect(page.getByText("请求头已保存", { exact: true })).toHaveCount(0)
  state.failFeatureSave = true
  const control = page.getByRole("switch", { name: "发送 Thread ID 请求头", exact: true })
  await control.click()
  await expect(page.getByText("无法保存实验性功能设置")).toBeVisible()
  await expect(control).not.toBeChecked()
  state.failFeatureSave = false
  await control.click()
  await expect(control).toBeChecked()
})

test("switching accounts cannot display cached administrator controls or carry a draft across sessions", async ({ page }) => {
  const state = await fixture(page)
  await page.goto(url)
  const input = page.getByLabel("User-Agent", { exact: true })
  await expect(input).toHaveValue("Existing/1.0")
  await input.fill("Private unsaved draft")
  await page.getByRole("button", { name: "Ordinary user", exact: true }).click()
  await expect(page.getByText("仅管理员可查看和修改系统配置。")).toBeVisible()
  await expect(input).toHaveCount(0)
  await expect(page.getByRole("switch")).toHaveCount(0)
  expect(state.calls.filter((call) => call.session === "user").every((call) => call.path === "/api/me")).toBe(true)
  await page.getByRole("button", { name: "Administrator", exact: true }).click()
  await expect(input).toHaveValue("Existing/1.0")
})

test("bilingual system controls remain usable in dark mode and narrow layouts", async ({ page }) => {
  await fixture(page)
  await page.goto(url)
  await expect(page.getByRole("switch")).toHaveCount(3)
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("switch", { name: "Send Thread ID header", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Save request headers", exact: true })).toBeDisabled()
  await page.screenshot({ path: "test-results/system-configuration-mobile.png", fullPage: true })
})
