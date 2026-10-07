import { expect, test } from "@playwright/test"

const groupSelector = '[data-slot="thread-process-group"]'
const imageGroupSelector = '[data-slot="thread-image-group"]'

async function itemSequence(page: import("@playwright/test").Page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-slot="message-scroller-item"]')].map((item) => {
    if (item.querySelector('[data-slot="thread-image-group"]')) return "images"
    if (item.querySelector('[data-slot="thread-process-group"]')) return "process"
    return item.querySelector("[data-record-id]")?.getAttribute("data-record-id")
      ?? item.querySelector("[data-record-image]")?.getAttribute("data-record-image")
      ?? "other"
  }))
}

test("generated images and screenshots stay visible while every process group is collapsed", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/thread-images.html")
  const groups = page.locator(groupSelector)
  await expect(groups).toHaveCount(3)
  for (const group of await groups.all()) await expect(group).not.toHaveAttribute("open")
  expect(await itemSequence(page)).toEqual(["1", "process", "3", "4", "5", "process", "8", "process", "10", "11", "12"])
  for (const id of [3, 8, 12]) {
    const image = page.locator(`[data-record-image="${id}"]`)
    await expect(image).toBeVisible()
    expect(await image.evaluate((node) => node.closest("details") === null)).toBe(true)
  }
  // A marked screenshot without PNG data is not image content: it stays inside its collapsed group.
  await expect(page.locator('[data-record-id="9"]')).toBeHidden()
  await groups.nth(2).locator(":scope > summary").click()
  await expect(page.locator('[data-record-id="9"]')).toBeVisible()
  expect(errors).toEqual([])
})

test("minimal mode shows each turn's images as one group with its final reply", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/thread-images.html")
  await page.getByRole("button", { name: "Minimal", exact: true }).click()
  await expect(page.locator("[data-record-image]")).toHaveCount(0)
  const imageGroups = page.locator(imageGroupSelector)
  await expect(imageGroups).toHaveCount(3)
  await expect(page.locator(`${imageGroupSelector} img`)).toHaveCount(3)
  for (const group of await imageGroups.all()) await expect(group).toBeVisible()
  await expect(page.locator(`${imageGroupSelector} img[alt="屏幕截图"]`)).toHaveCount(1)
  await expect(page.locator(`${imageGroupSelector} img[alt="生成的图片"]`)).toHaveCount(2)
  expect(await itemSequence(page)).toEqual(["1", "process", "4", "images", "5", "process", "10", "images", "11", "images"])
  const groups = page.locator(groupSelector)
  await expect(groups).toHaveCount(2)
  await expect(groups.first().locator(":scope > summary")).toContainText("1 条")
  await expect(groups.nth(1).locator(":scope > summary")).toContainText("3 条")
  await groups.nth(1).locator(":scope > summary").click()
  await expect(page.locator(`${groupSelector} img`)).toHaveCount(0)
  await expect(page.locator('[data-record-id="9"]')).toBeVisible()
  await expect(page.locator(`${imageGroupSelector} img`)).toHaveCount(3)
  await imageGroups.nth(1).getByRole("button", { name: "查看图片", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("生成的图片", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("button", { name: "Open image", exact: true })).toHaveCount(3)
  await expect(page.locator(`${imageGroupSelector} img[alt="Screenshot"]`)).toHaveCount(1)
  await expect(page.locator(`${imageGroupSelector} img[alt="Generated image"]`)).toHaveCount(2)
  expect(errors).toEqual([])
})

test("image groups wrap on narrow screens in both themes", async ({ page }) => {
  await page.goto("/e2e/thread-images.html")
  await page.getByRole("button", { name: "Minimal", exact: true }).click()
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await page.locator(imageGroupSelector).nth(1).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      expect(await page.locator('[data-slot="message-scroller-viewport"]').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: `test-results/thread-images-${theme}-${width}.png`, fullPage: true })
    }
  }
})
