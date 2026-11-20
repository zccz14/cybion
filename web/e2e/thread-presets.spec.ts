import { expect, test } from "@playwright/test"

test("the preset page lists the saved settings and opens them for editing", async ({ page }) => {
  await page.goto("/e2e/thread-presets.html")
  await expect(page.getByText("researcher", { exact: true })).toBeVisible()
  // 一行一句话：模型、强度、手册数、用过几次。
  await expect(page.getByText("gpt-6-astra · MAX · 3 本手册 · 用过 12 次")).toBeVisible()
  await expect(page.getByText("deepseek-flash · MAX · 1 本手册 · 用过 41 次")).toBeVisible()
  await expect(page.getByText("deepseek-flash · MAX · 无手册 · 用过 0 次")).toBeVisible()

  await page.getByRole("button", { name: "新建预设" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("预设名")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled()

  await dialog.getByLabel("预设名").fill("quant_researcher")
  await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled()
  await dialog.getByRole("button", { name: "保存" }).click()
  await expect(dialog).toBeHidden()

  // 空名字之外，重名也不许保存。
  await page.getByRole("button", { name: "新建预设" }).click()
  await page.getByRole("dialog").getByLabel("预设名").fill("researcher")
  await expect(page.getByRole("dialog").getByText("这个预设名已经存在。")).toBeVisible()
  await expect(page.getByRole("dialog").getByRole("button", { name: "保存" })).toBeDisabled()
})
