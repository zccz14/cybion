import { expect, test } from "@playwright/test"

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
