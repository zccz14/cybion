import { test, expect, type Page } from "@playwright/test"

async function fixture(page: Page, configured = true) {
  const state = { enabled: configured, configured, bot_id: configured ? "bot-1" : null, recipient_username: configured ? "owner" : null,
    last_attempt_at: null as number | null, last_success_at: null as number | null, last_error: null as string | null,
    conversation_id: null as string | null, message_id: null as string | null }
  let tests = 0
  let failure = false
  const calls: string[] = []
  await page.route("**/api/**", async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    calls.push(`${method} ${path}`)
    if (path === "/api/integrations/linkit/test") {
      tests++
      state.last_attempt_at = Math.floor(Date.now() / 1000)
      if (failure) {
        state.last_error = "Linkit send message failed (HTTP 404)"
        await route.fulfill({ status: 503, json: { error: state.last_error } })
        return
      }
      Object.assign(state, { last_success_at: state.last_attempt_at, last_error: null, conversation_id: "conversation-1", message_id: `message-${tests}` })
      await route.fulfill({ json: { id: state.message_id, conversation_id: state.conversation_id, sender_id: "bot-1", sender_kind: "bot" } })
      return
    }
    if (path === "/api/integrations/linkit" && method === "POST") Object.assign(state, { configured: true, bot_id: "bot-1", recipient_username: "owner" })
    else if (path === "/api/integrations/linkit" && method === "PUT") state.enabled = JSON.parse(request.postData() ?? "{}").enabled === true
    else if (!(path === "/api/integrations/linkit" && method === "GET")) throw new Error(`Unexpected cross-integration request ${method} ${path}`)
    await route.fulfill({ json: state })
  })
  return { calls, tests: () => tests, fail: () => { failure = true }, state }
}

test("repairing the connection and the switch enable, pause and keep receipts", async ({ page }) => {
  const state = await fixture(page, false)
  await page.goto("/e2e/linkit-notifications.html")
  await expect(page.getByText("连接未完成", { exact: true })).toBeVisible()
  await expect(page.getByRole("switch")).toBeDisabled()
  await expect(page.getByRole("button", { name: "发送测试通知", exact: true })).toBeDisabled()
  expect(state.tests()).toBe(0)
  await page.getByRole("button", { name: "修复连接", exact: true }).click()
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible()
  await expect(page.getByText("尚无投递记录。请发送测试通知验证这条通道。", { exact: true })).toBeVisible()
  await page.getByRole("switch").click()
  await expect(page.getByText("已开启", { exact: true })).toBeVisible()
  expect(state.state.enabled).toBe(true)
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("测试消息已投递到 Linkit。")
  await expect(page.getByRole("link", { name: "打开 Linkit 会话" })).toHaveAttribute("href", "https://linkit.ntnl.io/#/conversations/conversation-1")
  expect(state.tests()).toBe(1)
  await page.reload()
  await expect(page.getByText("message-1", { exact: true })).toBeVisible()
  expect(state.tests()).toBe(1)
  await page.getByRole("switch").click()
  await expect(page.getByText("已暂停", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "发送测试通知", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click()
  await expect(page.getByText("message-2", { exact: true })).toBeVisible()
  expect(state.state.enabled).toBe(false)
  expect(state.calls.every(call => call.includes("/api/integrations/linkit"))).toBe(true)
})

test("failed delivery stays visible after reload without a false success indication or automatic resend", async ({ page }) => {
  const state = await fixture(page)
  state.fail()
  await page.goto("/e2e/linkit-notifications.html")
  await page.getByRole("button", { name: "发送测试通知", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "HTTP 404" }).first()).toBeVisible()
  await expect(page.getByText("测试消息已投递到 Linkit。", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "打开 Linkit 会话" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("最近投递错误: Linkit send message failed (HTTP 404)")
  expect(state.tests()).toBe(1)
})

test("notification controls remain bilingual and fit a narrow viewport", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/e2e/linkit-notifications.html")
  await expect(page.getByText("Linkit 任务通知", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByText("Linkit task notifications", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send test notification", exact: true })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
