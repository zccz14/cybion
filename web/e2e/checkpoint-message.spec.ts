import { expect, test } from "@playwright/test"

const messageSelector = '[data-slot="checkpoint-message"]'

test("checkpoint content renders as Markdown and keeps its raw payload available", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/checkpoint-message.html")
  const message = page.locator(messageSelector)
  await expect(message.locator('[data-slot="checkpoint-label"]')).toHaveText("上下文检查点")
  await expect(message.getByText("内部记录", { exact: true })).toBeVisible()
  await expect(message.getByRole("heading", { name: "Durable working context", level: 1 })).toBeVisible()
  await expect(message.getByRole("heading", { name: "概念与术语", level: 2 })).toBeVisible()
  await expect(message.locator("li", { hasText: "Checkpoint" })).toBeVisible()
  await expect(message.locator("code", { hasText: "~/.cybion/users/<uid>.sqlite3" })).toBeVisible()
  await expect(message.locator("pre code", { hasText: "checkpoint-rendering" })).toBeVisible()
  const link = message.getByRole("link", { name: /Thread model/ })
  await expect(link).toHaveAttribute("href", "https://example.com/docs/threads")
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(message.getByText("继续验证 checkpoint 的渲染效果，然后检查暗色主题。", { exact: true })).toBeVisible()
  const payload = message.locator("pre", { hasText: '"role": "developer"' })
  await expect(payload).toBeHidden()
  await message.getByText("查看原始负载", { exact: true }).click()
  await expect(payload).toBeVisible()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(message.locator('[data-slot="checkpoint-label"]')).toHaveText("Checkpoint")
  await expect(message.getByText("Internal", { exact: true })).toBeVisible()
  await expect(message.getByText("View raw payload", { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test("checkpoint content reflows without horizontal overflow in both themes", async ({ page }) => {
  await page.goto("/e2e/checkpoint-message.html")
  const message = page.locator(messageSelector)
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await message.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
  await expect(message.getByRole("heading", { name: "Durable working context", level: 1 })).toBeVisible()
  await expect(message.locator("pre code", { hasText: "search_keywords" })).toBeVisible()
})
