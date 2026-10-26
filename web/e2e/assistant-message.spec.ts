import { expect, test } from "@playwright/test"

const messageSelector = '[data-slot="assistant-message"]'

test("Cybion output renders flat Markdown with the copy control and time below", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/assistant-message.html")
  const message = page.locator(messageSelector)
  await expect(message.getByRole("heading", { name: "部署状态", level: 2 })).toBeVisible()
  await expect(message.locator("strong", { hasText: "检查通过" })).toBeVisible()
  await expect(message.locator("pre code", { hasText: "git status" })).toBeVisible()
  await expect(message.locator("table").first()).toBeVisible()
  const link = message.getByRole("link", { name: /文档/ })
  await expect(link).toHaveAttribute("href", "https://example.com/docs")
  await expect(link).toHaveAttribute("target", "_blank")
  await expect(message.getByText("Cybion", { exact: true })).toHaveCount(0)
  const footer = message.locator('[data-slot="assistant-footer"]')
  await expect(footer.getByRole("button", { name: "复制", exact: true })).toBeVisible()
  await expect(footer.locator('[data-slot="assistant-time"]')).toHaveText("12:34:56")
  expect(await message.evaluate((node) => {
    const content = node.querySelector('[data-slot="assistant-content"]')
    const footerNode = node.querySelector('[data-slot="assistant-footer"]')
    return content !== null && footerNode !== null && content.compareDocumentPosition(footerNode) === Node.DOCUMENT_POSITION_FOLLOWING
  })).toBe(true)
  expect(errors).toEqual([])
})

test("Cybion output reflows without horizontal overflow in both themes", async ({ page }) => {
  await page.goto("/e2e/assistant-message.html")
  const message = page.locator(messageSelector)
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await message.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
  await expect(message.locator("pre code", { hasText: "git status" })).toBeVisible()
})

test("a table wider than the reply scrolls inside the table, not the page", async ({ page }) => {
  await page.goto("/e2e/assistant-message.html")
  await page.setViewportSize({ width: 390, height: 844 })
  const message = page.locator(messageSelector)
  const table = message.locator('[data-slot="markdown-table"]').last()
  await expect(table.locator("table")).toBeVisible()
  const before = await table.evaluate((node) => {
    node.scrollLeft = 0
    const box = node.getBoundingClientRect()
    const heads = node.querySelectorAll("th")
    const last = heads[heads.length - 1].getBoundingClientRect()
    return { overflow: node.scrollWidth - node.clientWidth, clipped: last.right > box.right + 1, contentWidth: node.parentElement!.clientWidth, width: node.clientWidth }
  })
  // 表格自己横向溢出，并且被自己的容器裁住，而不是把回复撑宽
  expect(before.overflow).toBeGreaterThan(0)
  expect(before.width).toBeLessThanOrEqual(before.contentWidth)
  expect(before.clipped).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const after = await table.evaluate((node) => {
    node.scrollLeft = node.scrollWidth
    const box = node.getBoundingClientRect()
    const heads = node.querySelectorAll("th")
    const last = heads[heads.length - 1].getBoundingClientRect()
    return { scrolled: node.scrollLeft, inside: last.right <= box.right + 1 && last.left >= box.left - 1, label: heads[heads.length - 1].textContent }
  })
  // 最后一列滚动之后完整可见
  expect(after.scrolled).toBeGreaterThan(0)
  expect(after.inside).toBe(true)
  expect(after.label).toBe("备注")
})
