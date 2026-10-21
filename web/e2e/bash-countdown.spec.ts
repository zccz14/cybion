import { expect, test, type Locator } from "@playwright/test"

const card = (page: import("@playwright/test").Page, name: string) => page.locator(`[data-card="${name}"]`)
const countdown = (page: import("@playwright/test").Page, name: string) => card(page, name).locator('[data-slot="bash-countdown"]')

// The delayed card counts whole seconds down, so its text ends in the number of
// seconds still left.
async function secondsLeft(locator: Locator) {
  const text = await locator.textContent()
  return Number(text?.match(/(\d+) 秒/)?.[1])
}

test("a call in flight counts the controller delay down every second", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/bash-countdown.html")
  const delayed = countdown(page, "delayed")
  await expect(delayed).toHaveAttribute("data-phase", "delayed")
  await expect(delayed).toContainText("延迟等待中 · 还剩")
  const first = await secondsLeft(delayed)
  expect(first).toBeLessThanOrEqual(40)
  expect(first).toBeGreaterThanOrEqual(36)
  // The Worker timeout clock starts only after the delay, so a delayed card never
  // reports the timeout.
  await expect(delayed).not.toContainText("超时还剩")
  await expect.poll(async () => secondsLeft(delayed), { timeout: 5000 }).toBeLessThan(first)
  expect(errors).toEqual([])
})

test("the Worker timeout, its default and the settled card each read their own state", async ({ page }) => {
  await page.goto("/e2e/bash-countdown.html")
  await expect(countdown(page, "running")).toHaveAttribute("data-phase", "running")
  await expect(countdown(page, "running")).toContainText("执行中 · 超时还剩")
  // A call that names no timeout counts against the tool's documented 600 seconds.
  await expect(countdown(page, "expired")).toHaveAttribute("data-phase", "expired")
  await expect(countdown(page, "expired")).toHaveText("已过超时 · 正在取消")
  // A settled call has no deadline left to show.
  await expect(card(page, "settled").locator('[data-slot="bash-countdown"]')).toHaveCount(0)
})
