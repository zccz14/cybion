import { expect, test } from "@playwright/test"

// Two records share the same id in the fixture, so scope every assertion to the
// card that owns a control rather than to the page.
const actionable = (page: import("@playwright/test").Page) => page.locator("#actionable [data-slot=\"budget-stop-notice\"]")

test("a budget stop reads in the user's language and offers to add budget", async ({ page }) => {
  await page.goto("/e2e/budget-stop.html")
  const card = actionable(page)
  await expect(card).toContainText("已达花费上限")
  // Restated from the amounts on the record, not from the Controller's English prose.
  await expect(card).toContainText("预算已耗尽：已结算 $0.54，上限 $0.01。")
  await expect(card).not.toContainText("Budget exhausted")

  const amount = card.getByLabel("追加预算（USD）")
  await expect(amount).toHaveValue("1")
  await expect(card).toContainText("新上限：$1.54")

  // A half-typed decimal point stays in the field (the bug the settings panel had).
  await amount.fill("")
  await amount.pressSequentially("0.0", { delay: 30 })
  await expect(amount).toHaveValue("0.0")
  await amount.pressSequentially("5", { delay: 30 })
  await expect(amount).toHaveValue("0.05")
  await expect(card).toContainText("新上限：$0.59")

  await card.getByRole("button", { name: "追加并继续" }).click()
  await expect(page.getByTestId("raised")).toHaveText("50000000")

  // The default round-trips as one dollar in whole nanodollars.
  await amount.fill("1")
  await card.getByRole("button", { name: "追加并继续" }).click()
  await expect(page.getByTestId("raised")).toHaveText("1000000000")
})

test("the panel follows the language, and a read-only Thread gets no control", async ({ page }) => {
  await page.goto("/e2e/budget-stop.html")
  await page.getByRole("button", { name: "Language" }).click()
  const card = actionable(page)
  await expect(card).toContainText("Spend limit reached")
  await expect(card).toContainText("Budget exhausted: $0.54 settled of the $0.01 limit.")
  await expect(card.getByLabel("Budget to add (USD)")).toHaveValue("1")
  await expect(card).toContainText("New limit: $1.54")
  await expect(card.getByRole("button", { name: "Add and continue" })).toBeVisible()

  const readOnly = page.locator("#read-only [data-slot=\"budget-stop-notice\"]")
  await expect(readOnly).toContainText("Spend limit reached")
  await expect(readOnly.getByRole("textbox")).toHaveCount(0)
  await expect(readOnly.getByRole("button")).toHaveCount(0)

  // The generic activity card is still the generic activity card.
  await expect(page.locator("#ordinary")).toContainText("Activity")
  await expect(page.locator("#ordinary [data-slot=\"budget-stop-notice\"]")).toHaveCount(0)
})

test("the panel fits a narrow screen and stays inside a dark theme", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/e2e/budget-stop.html")
  await page.getByRole("button", { name: "Theme" }).click()
  const card = actionable(page)
  await expect(card.getByLabel("追加预算（USD）")).toBeVisible()
  await expect(card.getByRole("button", { name: "追加并继续" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const box = await card.boundingBox()
  expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  await page.screenshot({ path: "test-results/budget-stop.png" })
})
