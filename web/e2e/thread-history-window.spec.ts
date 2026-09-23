import { expect, test } from "@playwright/test"

const input = (turn: number) => `第 ${turn} 轮用户输入：先看一下部署状态，然后继续跑测试。`
const loadEarlier = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Load earlier", exact: true })

test("loading earlier pages keeps the first visible row in place and ends at the thread start", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/thread-history-window.html")
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await expect(page.getByText(input(20), { exact: true })).toBeVisible()
  await page.mouse.move(640, 360)
  await page.mouse.wheel(0, -20000)
  await page.waitForTimeout(300)
  const anchor = page.getByText(input(11), { exact: true })
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  await loadEarlier(page).click()
  await expect(page.getByText(input(7), { exact: true })).toBeAttached()
  const after = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
  await page.mouse.wheel(0, -3000)
  await expect(page.getByText(input(7), { exact: true })).toBeVisible()
  await loadEarlier(page).click()
  await loadEarlier(page).click()
  await expect(loadEarlier(page)).toHaveCount(0)
  await expect(page.getByText(input(1), { exact: true })).toBeAttached()
  expect(errors).toEqual([])
})

test("loading earlier while at the latest turn keeps the latest turn in place", async ({ page }) => {
  await page.goto("/e2e/thread-history-window.html")
  const viewport = page.locator('[data-slot="message-scroller-viewport"]')
  await expect(page.getByText(input(20), { exact: true })).toBeVisible()
  expect(await viewport.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true)
  const anchor = page.getByText(input(19), { exact: true })
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  await loadEarlier(page).click()
  await expect(page.getByText(input(7), { exact: true })).toBeAttached()
  const after = await anchor.evaluate((element) => element.getBoundingClientRect().top)
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
})
