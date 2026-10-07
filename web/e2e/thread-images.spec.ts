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
  expect(await itemSequence(page)).toEqual(["1", "process", "3", "4", "5", "process", "8", "9", "process", "11", "12", "13"])
  for (const id of [3, 8, 9, 13]) {
    const image = page.locator(`[data-record-image="${id}"]`)
    await expect(image).toBeVisible()
    expect(await image.evaluate((node) => node.closest("details") === null)).toBe(true)
  }
  await expect(page.locator("[data-record-image]")).toHaveCount(4)
  // A marked screenshot without PNG data is not image content: it stays inside its collapsed group.
  await expect(page.locator('[data-record-id="10"]')).toBeHidden()
  await groups.nth(2).locator(":scope > summary").click()
  await expect(page.locator('[data-record-id="10"]')).toBeVisible()
  expect(errors).toEqual([])
})

test("minimal mode shows each turn's images as one one-row image group with its final reply", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/thread-images.html")
  await page.getByRole("button", { name: "Minimal", exact: true }).click()
  await expect(page.locator("[data-record-image]")).toHaveCount(0)
  const imageGroups = page.locator(imageGroupSelector)
  await expect(imageGroups).toHaveCount(3)
  await expect(page.locator(`${imageGroupSelector} img`)).toHaveCount(4)
  for (const group of await imageGroups.all()) await expect(group).toBeVisible()
  await expect(page.locator(`${imageGroupSelector} img[alt="屏幕截图"]`)).toHaveCount(1)
  await expect(page.locator(`${imageGroupSelector} img[alt="生成的图片"]`)).toHaveCount(3)
  expect(await itemSequence(page)).toEqual(["1", "process", "4", "images", "5", "process", "11", "images", "12", "images"])
  const groups = page.locator(groupSelector)
  await expect(groups).toHaveCount(2)
  await expect(groups.first().locator(":scope > summary")).toContainText("1 条")
  await expect(groups.nth(1).locator(":scope > summary")).toContainText("3 条")
  // Only a turn with multiple images gets carousel controls, and the images stay on one row.
  await expect(page.getByRole("button", { name: "Next slide", exact: true })).toHaveCount(1)
  await expect(imageGroups.nth(0).getByRole("button", { name: "Previous slide", exact: true })).toHaveCount(0)
  await expect(imageGroups.nth(2).getByRole("button", { name: "Previous slide", exact: true })).toHaveCount(0)
  const slides = imageGroups.nth(1).locator('[data-slot="carousel-item"]')
  await expect(slides).toHaveCount(2)
  const previous = imageGroups.nth(1).getByRole("button", { name: "Previous slide", exact: true })
  const next = imageGroups.nth(1).getByRole("button", { name: "Next slide", exact: true })
  await expect(previous).toBeDisabled()
  await expect(next).toBeEnabled()
  await expect(slides.nth(0)).toBeInViewport({ ratio: 0.5 })
  await next.click()
  await expect(slides.nth(1)).toBeInViewport({ ratio: 0.5 })
  await expect(slides.nth(0)).not.toBeInViewport({ ratio: 0.5 })
  await expect(previous).toBeEnabled()
  await expect(next).toBeDisabled()
  await previous.click()
  await expect(slides.nth(0)).toBeInViewport({ ratio: 0.5 })
  // Expanding the process group never duplicates the grouped images.
  await groups.nth(1).locator(":scope > summary").click()
  await expect(page.locator(`${groupSelector} img`)).toHaveCount(0)
  await expect(page.locator('[data-record-id="10"]')).toBeVisible()
  await expect(page.locator(`${imageGroupSelector} img`)).toHaveCount(4)
  await imageGroups.nth(1).getByRole("button", { name: "查看图片", exact: true }).first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("生成的图片", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("button", { name: "Open image", exact: true })).toHaveCount(4)
  await expect(page.locator(`${imageGroupSelector} img[alt="Screenshot"]`)).toHaveCount(1)
  await expect(page.locator(`${imageGroupSelector} img[alt="Generated image"]`)).toHaveCount(3)
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
