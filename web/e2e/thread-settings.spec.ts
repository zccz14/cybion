import { expect, test } from "@playwright/test"

test("the popover groups models by upstream and edits reasoning effort and fast mode", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  const trigger = page.getByRole("button", { name: "线程设置" })
  await expect(trigger).toHaveText("deepseek-flash (medium)")
  await trigger.click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(popover).toBeVisible()
  await expect(popover.getByText("推理强度")).toBeVisible()
  const scale = popover.locator('[data-slot="reasoning-effort-scale"]')
  for (const stop of ["low", "medium", "high", "xhigh", "max"]) await expect(scale.getByText(stop, { exact: true })).toBeVisible()
  const effortValue = popover.locator('[data-slot="reasoning-effort-value"]')
  await expect(effortValue).toHaveText("medium")
  await popover.getByRole("combobox", { name: "模型" }).click()
  await expect(page.getByText("DeepSeek", { exact: true })).toBeVisible()
  await expect(page.getByText("OpenAI-LB", { exact: true })).toBeVisible()
  await expect(page.getByText("Could not load models")).toBeVisible()
  await page.getByRole("option", { name: "gpt-6-astra" }).click()
  await expect(page.getByTestId("selection")).toHaveText("up-deepseek:gpt-6-astra")
  await expect(trigger).toHaveText("gpt-6-astra (medium)")
  await popover.getByRole("combobox", { name: "模型" }).click()
  await page.getByRole("option", { name: "meta-llama/Llama-3.1-8B-Instruct" }).click()
  await expect(page.getByTestId("selection")).toHaveText("up-lb:meta-llama/Llama-3.1-8B-Instruct")
  await expect(trigger).toHaveText("meta-llama/Llama-3.1-8B-Instruct (medium)")
  const slider = popover.getByRole("slider")
  await slider.press("End")
  await expect(page.getByTestId("effort")).toHaveText("max")
  await expect(effortValue).toHaveText("max")
  await expect(trigger).toHaveText("meta-llama/Llama-3.1-8B-Instruct (max)")
  await slider.press("ArrowLeft")
  await expect(page.getByTestId("effort")).toHaveText("xhigh")
  await expect(effortValue).toHaveText("xhigh")
  await expect(trigger).toHaveText("meta-llama/Llama-3.1-8B-Instruct (xhigh)")
  await popover.getByRole("switch").click()
  await expect(page.getByTestId("fast")).toHaveText("true")
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden()
})

test("the popover offers exactly the settings both places share", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  await page.getByRole("button", { name: "线程设置" }).click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(popover).toBeVisible()
  // Model, reasoning effort, fast mode — no budgets, caps, gates or model slots.
  for (const label of ["重放预算", "已加载手册上限", "初始手册", "极简模式", "语音识别", "图像生成"]) {
    await expect(popover.getByText(label, { exact: true })).toHaveCount(0)
  }
  await page.screenshot({ path: "test-results/thread-settings-shared.png" })
})

test("the popover caps its height and scrolls instead of overflowing a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 200 })
  await page.goto("/e2e/thread-settings.html")
  await page.getByRole("button", { name: "线程设置" }).click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(popover).toBeVisible()
  // 上限是 24rem 与可用高度里更小的那个：矮视口下面板自己变矮，而不是顶出屏幕。
  const box = await popover.boundingBox()
  expect(box !== null && box.height <= 200).toBe(true)
  expect(box !== null && box.y >= 0 && box.y + box.height <= 200).toBe(true)
  // 内容比面板高，所以在面板内部滚动；滚到底部能露出最后一项（快速模式）。
  const overflow = await popover.evaluate((element) => ({ client: element.clientHeight, scroll: element.scrollHeight }))
  expect(overflow.scroll).toBeGreaterThan(overflow.client)
  const fastMode = popover.getByRole("switch")
  await popover.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(fastMode).toBeInViewport()
  await page.screenshot({ path: "test-results/thread-settings-short-viewport.png" })
})

test("the popover follows the language and stays within narrow layouts", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  await page.setViewportSize({ width: 390, height: 844 })
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark)
      await page.getByRole("button", { name: language === "en" ? "Thread settings" : "线程设置" }).click()
      const popover = page.locator('[data-slot="popover-content"]')
      await expect(popover).toBeVisible()
      await expect(popover).toContainText(language === "en" ? "Reasoning effort" : "推理强度")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.keyboard.press("Escape")
      await expect(popover).toBeHidden()
    }
  }
  await page.screenshot({ path: "test-results/thread-settings-mobile.png" })
})

test("a long selection truncates inside the composer row on narrow layouts", async ({ page }) => {
  await page.goto("/e2e/thread-settings.html")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "线程设置" }).click()
  const popover = page.locator('[data-slot="popover-content"]')
  await popover.getByRole("combobox", { name: "模型" }).click()
  await page.getByRole("option", { name: "meta-llama/Llama-3.1-8B-Instruct" }).click()
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden()
  const trigger = page.getByRole("button", { name: "线程设置" })
  await expect(trigger).toHaveText("meta-llama/Llama-3.1-8B-Instruct (medium)")
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const spans = await trigger.evaluate((element) => {
    const [model, effort] = element.querySelectorAll("span")
    return { model: model.scrollWidth > model.clientWidth, effort: effort.scrollWidth > effort.clientWidth }
  })
  expect(spans).toEqual({ model: true, effort: false })
  const box = await trigger.boundingBox()
  expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true)
  await page.screenshot({ path: "test-results/thread-settings-long-model.png" })
})
