import { expect, test } from "@playwright/test"

test("each row shows compact lifetime usage and the header exposes exact totals and the calculation", async ({ page }) => {
  await page.goto("/e2e/thread-usage.html#/threads/measured")
  const measured = page.getByRole("link", { name: /长线程/ })
  await expect(measured).toContainText("1.2M tokens")
  await expect(measured).toContainText("缓存 75%")
  await expect(page.getByRole("link", { name: /New thread/ })).toContainText("0 tokens")
  await expect(page.getByRole("link", { name: /New thread/ })).toContainText("缓存 —")
  await expect(page.getByRole("link", { name: /No cache hit/ })).toContainText("缓存 0%")
  await expect(page.getByRole("link", { name: /Very large usage/ })).toContainText("1T tokens")
  await measured.focus()
  await expect(page.getByRole("tooltip")).toContainText("1,234,567")
  await expect(page.getByRole("tooltip")).toContainText("750,000")
  await expect(page.getByRole("tooltip").locator("dt")).toHaveCount(5)
  await expect(page.getByRole("tooltip").locator("p")).toHaveCount(1)
  await page.keyboard.press("Escape")
  const panel = page.locator('[data-slot="thread-usage-panel"]')
  await expect(panel.locator("summary")).toContainText("累计 Token 1,234,567")
  await panel.locator("summary").focus()
  await page.keyboard.press("Enter")
  await expect(panel).toContainText("缓存 Token 属于输入，不重复计入总量")
  await expect(panel).toContainText("输入 Token1,000,000")
  await page.getByRole("button", { name: "Poll update", exact: true }).click()
  await expect(panel).toHaveAttribute("open", "")
  await expect(panel.locator("summary")).toContainText("1,235,567")
  await expect(measured).toContainText("缓存 74.9%")
  await page.getByRole("button", { name: "No cache data", exact: true }).click()
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    await expect(measured).toContainText(language === "en" ? "Cache —" : "缓存 —")
    await expect(measured.locator('[data-slot="thread-usage-summary"] > span')).toHaveCount(2)
    await expect(panel.locator("summary > span")).toHaveCount(2)
    await expect(panel.locator("summary")).toContainText("1,235,567")
    await expect(panel.locator("dt")).toHaveCount(5)
    await expect(panel.locator("dd")).toHaveText(["1,235,567", "1,001,000", "234,567", "750,000", "—"])
    await expect(panel.locator("p")).toHaveCount(1)
  }
})

test("usage stays visible in narrow light/dark layouts and both languages", async ({ page }) => {
  await page.goto("/e2e/thread-usage.html#/threads/measured")
  await page.locator('[data-slot="thread-usage-panel"] summary').click()
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark)
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await expect(page.getByRole("link", { name: /长线程/ })).toContainText("1.2M tokens")
        await expect(page.getByRole("link", { name: /长线程/ })).toContainText(language === "en" ? "Cache 75%" : "缓存 75%")
      }
    }
  }
  await page.screenshot({ path: "test-results/thread-usage-mobile.png", fullPage: true })
})
