import { test, expect } from "@playwright/test"

test.use({ reducedMotion: "no-preference" })

test("the help dialog tells the Shannon story and the box switches itself off on loop", async ({ page }) => {
  await page.goto("/e2e/ultimate-machine-help.html")
  const help = page.getByRole("button", { name: "关于「终极机器」" })
  await expect(help).toBeVisible()
  await help.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("「终极机器」的来历")
  await expect(dialog).toContainText("马文·明斯基")
  await expect(dialog).toContainText("香农")
  await expect(dialog).toContainText("阿瑟·克拉克")
  const scene = dialog.locator(".um-scene")
  await expect(scene).toBeVisible()
  for (const name of ["um-lid", "um-lever", "um-led", "um-rod", "um-fist", "um-swing"]) {
    await expect(dialog.locator(`.${name}`)).toHaveCSS("animation-name", name)
    await expect(dialog.locator(`.${name}`)).toHaveCSS("animation-iteration-count", "infinite")
  }
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: "Language" }).click()
  await page.getByRole("button", { name: "About the Ultimate Machine" }).click()
  const english = page.getByRole("dialog")
  await expect(english).toContainText("Where the “Ultimate Machine” comes from")
  await expect(english).toContainText("Bell Labs, 1952")
  await expect(english).toContainText("switch itself off")
})
