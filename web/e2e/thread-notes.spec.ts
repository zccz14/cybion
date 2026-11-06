import { expect, test } from "@playwright/test"

const row = (page: import("@playwright/test").Page) => page.locator('[data-slot="thread-notes"]')

test("the notes row lists every open note above the loaded manuals and disappears when empty", async ({ page }) => {
  await page.goto("/e2e/thread-notes.html")
  await expect(row(page)).toBeVisible()
  await expect(row(page).locator("> span").nth(0)).toContainText("便签")
  await expect(row(page).locator("> span").nth(0)).toContainText("3")
  await expect(row(page).locator("> span")).toHaveCount(4)
  // The row sits above the manuals row, not below it.
  const notesBox = await row(page).boundingBox()
  const manualsBox = await page.getByTestId("manuals").boundingBox()
  expect(notesBox!.y + notesBox!.height).toBeLessThanOrEqual(manualsBox!.y + 1)
  // Full text stays reachable even when the chip truncates.
  await expect(row(page).locator("> span").nth(3)).toHaveAttribute("title", /WAL 增长是否还在阈值内/)
  await page.getByRole("button", { name: "Count", exact: true }).click()
  await expect(row(page).locator("> span")).toHaveCount(2)
  await page.getByRole("button", { name: "Count", exact: true }).click()
  await expect(row(page)).toHaveCount(0)
})

test("the notes row stays inside narrow layouts and reads in both themes and languages", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await page.goto("/e2e/thread-notes.html")
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    const overflows = await row(page).evaluate((element) => element.scrollWidth > element.clientWidth + 1)
    expect(overflows).toBe(false)
    const chip = row(page).locator("> span").nth(3).locator("span")
    // A long note truncates instead of pushing the row sideways, and the chip keeps one line.
    const box = await chip.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(256)
  }
  // Both languages label the row; the chips stay the Thread's own words.
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(row(page).locator("> span").nth(0)).toContainText("Notes")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(row(page).locator("> span").nth(0)).toContainText("便签")
})
