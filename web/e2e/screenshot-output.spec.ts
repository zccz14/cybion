import { expect, test } from "@playwright/test"

test("a screenshot output shows its image and opens the zoom dialog", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/screenshot-output.html")
  const image = page.getByRole("img")
  await expect(image).toHaveCount(1)
  await expect(image).toHaveAttribute("alt", "屏幕截图")
  await page.getByRole("button", { name: "查看截图", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("img").first()).toHaveAttribute("alt", "Screenshot")
  await expect(page.getByRole("button", { name: "Open screenshot", exact: true })).toBeVisible()
  expect(errors).toEqual([])
})
