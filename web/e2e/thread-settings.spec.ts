import { expect, test } from "@playwright/test"

test("the popover edits model, reasoning effort and fast mode", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  await page.getByRole("button", { name: "线程设置" }).click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(popover).toBeVisible()
  await expect(popover.getByText("推理强度")).toBeVisible()
  const scale = popover.locator('[data-slot="reasoning-effort-scale"]')
  for (const stop of ["low", "medium", "high", "xhigh", "max"]) await expect(scale.getByText(stop, { exact: true })).toBeVisible()
  const effortValue = popover.locator('[data-slot="reasoning-effort-value"]')
  await expect(effortValue).toHaveText("medium")
  await popover.getByRole("combobox").click()
  await page.getByRole("option", { name: "gpt-6-astra" }).click()
  await expect(page.getByTestId("model")).toHaveText("gpt-6-astra")
  const slider = popover.getByRole("slider")
  await slider.press("End")
  await expect(page.getByTestId("effort")).toHaveText("max")
  await expect(effortValue).toHaveText("max")
  await slider.press("ArrowLeft")
  await expect(page.getByTestId("effort")).toHaveText("xhigh")
  await expect(effortValue).toHaveText("xhigh")
  await popover.getByRole("switch").click()
  await expect(page.getByTestId("fast")).toHaveText("true")
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden()
})

test("the popover follows the language and stays within narrow layouts", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  await page.setViewportSize({ width: 390, height: 844 })
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark)
      await page.getByRole("button", { name: language === "en" ? "Thread settings" : "线程设置" }).click()
      const popover = page.locator('[data-slot="popover-content"]')
      await expect(popover).toBeVisible()
      await expect(popover).toContainText(language === "en" ? "Reasoning effort" : "推理强度")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.keyboard.press("Escape")
      await expect(popover).toBeHidden()
    }
  }
  await page.screenshot({ path: "test-results/thread-settings-mobile.png" })
})
