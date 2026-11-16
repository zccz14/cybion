import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

// The account default and the Thread panel are two places the same limit is set.
// Both must actually carry it: a default that never reaches the API is a setting
// the user does not have, and a composer that shows one setting while starting the
// Thread with another breaks the rule that what the panel shows lands on the Thread.
test("the account default carries a spend limit to the API", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/configuration")
  const field = page.locator("#default-thread-usd-budget")
  await expect(field).toBeVisible()
  await expect(field).toHaveValue("0")

  // A half-typed decimal point stays in the box, and only complete amounts commit.
  await field.fill("")
  await field.pressSequentially("0.0", { delay: 30 })
  await expect(field).toHaveValue("0.0")
  await field.pressSequentially("5", { delay: 30 })
  await expect(field).toHaveValue("0.05")

  await page.getByRole("button", { name: "保存默认设置" }).click()
  await expect.poll(() => fixture.writes.filter((entry) => entry.path === "/api/thread-defaults" && entry.body.budget_usd_nanos === 50_000_000).length).toBe(1)
  await expect(page.getByText("默认设置已保存")).toBeVisible()
  await page.screenshot({ path: "test-results/configuration-usd-budget.png", fullPage: true })
  expect(fixture.unexpected).toEqual([])
})

test("a budget set in the new-thread panel starts the thread with that budget", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/threads")
  await page.getByRole("button", { name: "新建对话", exact: true }).click()
  await page.getByRole("textbox", { name: "你希望 Cybion 处理什么？" }).fill("试一下预算。")

  await page.getByRole("button", { name: /^线程设置:/ }).click()
  const limit = page.locator("#thread-settings-usd-budget")
  await limit.scrollIntoViewIfNeeded()
  await expect(limit).toBeVisible()
  await limit.fill("0.25")

  await page.getByRole("button", { name: "开始对话", exact: true }).click()
  await expect(page).toHaveURL(/#\/threads\/created-thread/)
  const starts = fixture.writes.filter((entry) => entry.path === "/api/threads/start")
  expect(starts).toHaveLength(1)
  expect(starts[0].body.budget_usd_nanos).toBe(250_000_000)
  expect(fixture.unexpected).toEqual([])
})
