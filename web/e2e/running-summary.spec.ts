import { expect, test } from "@playwright/test"

const summary = "检查 Node 版本是否满足构建要求"

test("a running Thread shows the newest Worker call's intent summary instead of the running label", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/running-summary.html")
  const rows = page.getByRole("navigation").locator('[data-thread-status="running"]')
  // The row with a call in flight replaces the label; the row waiting on the
  // model keeps the canonical copy.
  await expect(rows.first()).toContainText(summary)
  await expect(rows.first().locator('[data-slot="thread-status-label"]')).toHaveAttribute("title", /检查 Node 版本/)
  await expect(rows.nth(1).getByText("运行中", { exact: true })).toBeVisible()
  const badges = page.getByTestId("badges").locator('[data-thread-status="running"]')
  await expect(badges.first()).toContainText(summary)
  await expect(badges.nth(1)).toHaveText("运行中")
  // A long summary truncates inside the row instead of widening the layout.
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(errors).toEqual([])
  await page.screenshot({ path: "test-results/running-summary.png", fullPage: true })
})
