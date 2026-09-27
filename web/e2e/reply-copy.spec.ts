import { expect, test } from "@playwright/test"

test.use({ permissions: ["clipboard-read", "clipboard-write"] })

const pageUrl = "/e2e/reply-copy.html"
const reply = "## 部署状态\n\n- 检查通过\n- 服务健康"

test("the reply copy button writes the exact reply text to the clipboard and clears its copied status", async ({ page }) => {
  await page.goto(pageUrl)
  await page.getByRole("button", { name: "复制", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("已复制")
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reply)
  await expect(page.getByRole("status")).toHaveText("", { timeout: 3000 })
})

test("a failed clipboard write asks for manual copying instead of claiming success", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"))
  })
  await page.goto(pageUrl)
  await page.getByRole("button", { name: "复制", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("复制失败，请手动选择并复制内容。")
})

test("the copy control follows the UI language", async ({ page }) => {
  await page.goto(pageUrl)
  await page.getByRole("button", { name: "Language", exact: true }).click()
  const button = page.getByRole("button", { name: "Copy", exact: true })
  await expect(button).toBeVisible()
  await button.click()
  await expect(page.getByRole("status")).toHaveText("Copied")
})

test("the copy control and its failure guidance wrap within narrow light and dark layouts", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"))
  })
  await page.goto(pageUrl)
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const language of ["zh", "en"]) {
      if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
      await page.getByRole("button", { name: language === "zh" ? "复制" : "Copy", exact: true }).click()
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await expect(page.getByRole("status")).toContainText(language === "zh" ? "复制失败" : "Copy failed")
      }
    }
    await page.getByRole("button", { name: "Language", exact: true }).click()
  }
})
