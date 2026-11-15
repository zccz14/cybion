import { expect, test } from "@playwright/test"

// 视觉核验用：把语音控件的每个状态摆在手机与桌面两个宽度下截图。
test("voice state sheet", async ({ page }) => {
  for (const [name, viewport] of [["phone", { width: 390, height: 900 }], ["desktop", { width: 1280, height: 900 }]] as const) {
    await page.setViewportSize(viewport)
    await page.goto("/e2e/composer-voice-states.html")
    await expect(page.getByTestId("states")).toBeVisible()
    await page.screenshot({ path: `/tmp/voice-${name}.png`, fullPage: true })
  }
})
