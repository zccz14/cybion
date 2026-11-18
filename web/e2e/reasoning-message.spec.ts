import { expect, test } from "@playwright/test"

const cardSelector = '[data-slot="reasoning-message"]'

test("a reasoning card shows its summary, and the reasoning content when there is no summary", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/reasoning-message.html")
  const cards = page.locator(cardSelector)
  await expect(cards).toHaveCount(3)
  // 有 summary 时只显示 summary，原始 content 仍留在原始负载里。
  await expect(cards.nth(0)).toContainText("正在分析部署记录，先看最近一次构建。")
  await expect(cards.nth(0).getByText("原始推理文本：不应该出现在卡片里。", { exact: true })).toBeHidden()
  // summary 为空时卡片显示内容本身，而不是一个空卡片。
  await expect(cards.nth(1)).toContainText("Clippy passed. Now run cargo test. This will rebuild test binaries (target reused).")
  await expect(cards.nth(1)).toContainText("Let me run the full test suite.")
  // 两者都没有时保留占位符。
  await expect(cards.nth(2)).toContainText("—")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(cards.nth(1)).toContainText("Reasoning")
  expect(errors).toEqual([])
})

test("the card survives both themes and narrow screens without overflowing", async ({ page }) => {
  await page.goto("/e2e/reasoning-message.html")
  const cards = page.locator(cardSelector)
  for (const theme of ["light", "dark"]) {
    await page.evaluate((next) => {
      document.documentElement.classList.toggle("dark", next === "dark")
    }, theme)
    await page.setViewportSize({ width: 390, height: 844 })
    for (const card of await cards.all()) {
      const box = await card.boundingBox()
      expect(box!.width).toBeLessThanOrEqual(390)
    }
  }
})
