import { expect, test } from "@playwright/test"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

test("user input renders its text, its pasted images and opens a preview", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/user-input-message.html")
  const groups = page.locator('[data-slot="message-group"]')
  await expect(groups).toHaveCount(3)
  await expect(page.getByText("看看这张图。", { exact: true })).toBeVisible()
  await expect(page.getByText("这个报错怎么回事？", { exact: true })).toBeVisible()
  await expect(page.getByRole("img")).toHaveCount(3)
  await expect(page.getByRole("img").first()).toHaveAttribute("alt", "粘贴的图片")
  await expect(groups.nth(2).locator(".bg-user-message")).toHaveCount(0)
  await page.getByRole("button", { name: "查看图片" }).first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("img").first()).toHaveAttribute("alt", "Pasted image")
  await expect(page.getByRole("button", { name: "Open image" }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test("user input exposes the shared copy control beneath its bubble", async ({ page }) => {
  await page.goto("/e2e/user-input-message.html")
  const groups = page.locator('[data-slot="message-group"]')
  const first = groups.first()
  const button = first.getByRole("button", { name: "复制", exact: true })
  await expect(button).toBeVisible()
  expect(await first.evaluate((node) => {
    const bubble = node.querySelector(".bg-user-message")
    const control = node.querySelector('button[aria-label="复制"]')
    return bubble !== null && control !== null && bubble.compareDocumentPosition(control) === Node.DOCUMENT_POSITION_FOLLOWING
  })).toBe(true)
  await button.click()
  await expect(first.getByRole("status")).toHaveText("已复制")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("看看这张图。")
  await expect(groups.nth(2).getByRole("button", { name: "复制", exact: true })).toHaveCount(0)
})
