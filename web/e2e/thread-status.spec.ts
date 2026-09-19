import { expect, test } from "@playwright/test"

const states = [
  ["running", "运行中", "Running", "loader"],
  ["completed", "已完成", "Completed", "check"],
  ["failed", "执行失败", "Failed", "triangle-alert"],
  ["stopped", "已停止", "Stopped", "square"],
  ["ready", "待开始", "Ready", "message-square-dashed"],
  ["compacting", "压缩中", "Compacting", "minimize-2"],
] as const

test("all states have distinct icons, visible bilingual text, and matching detail badges", async ({ page }) => {
  await page.goto("/e2e/thread-status.html#/threads/running")
  const links = page.getByRole("navigation").getByRole("link")
  await expect(links).toHaveCount(6)
  for (const [status, zh, , icon] of states) {
    const link = page.getByRole("navigation").locator(`[data-thread-status="${status}"]`)
    await expect(link.getByText(zh, { exact: true })).toBeVisible()
    await expect(link.locator(`svg.lucide-${icon}`)).toBeVisible()
    await expect(link.locator("svg")).toHaveAttribute("aria-hidden", "true")
    await expect(page.getByTestId("badges").locator(`[data-thread-status="${status}"]`)).toHaveText(zh)
  }
  await expect(links.first()).toHaveAttribute("aria-current", "page")
  await links.nth(1).click()
  await expect(links.nth(1)).toHaveAttribute("aria-current", "page")
  await expect(links.first()).not.toHaveAttribute("aria-current", "page")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  for (const [status, , en] of states) {
    await expect(page.getByRole("navigation").locator(`[data-thread-status="${status}"]`)).toContainText(en)
    await expect(page.getByTestId("badges").locator(`[data-thread-status="${status}"]`)).toHaveText(en)
  }
})

test("keyboard focus explains the state and reduced motion stops only the running animation", async ({ page }) => {
  await page.goto("/e2e/thread-status.html#/threads/running")
  const link = page.getByRole("link", { name: /重新设计/ })
  await page.getByRole("button", { name: "Complete", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(link).toBeFocused()
  await expect(page.getByRole("tooltip")).toContainText("正在执行本次请求。")
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(link.locator("svg")).toHaveCSS("animation-name", "spin")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(link.locator("svg")).toHaveCSS("animation-name", "none")
  await expect(link).toContainText("运行中")
  await page.getByRole("button", { name: "Complete", exact: true }).click()
  await expect(link).toHaveAttribute("data-thread-status", "completed")
  await expect(link.locator("svg.lucide-check")).toBeVisible()
  await expect(link).toContainText("已完成")
  await expect(page.getByTestId("badges").locator('[data-thread-status="running"]')).toHaveCount(0)
})

test("long titles, selected states and readable status colors work in light and dark mobile layouts", async ({ page }) => {
  await page.goto("/e2e/thread-status.html#/threads/running")
  for (const theme of ["light", "dark"] as const) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    // Ask the browser to resolve CSS colors, including OKLCH and alpha compositing.
    const contrast = await page.getByRole("navigation").getByRole("link").evaluateAll((links) => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d")!
      function rgb(color: string) {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return Array.from(context.getImageData(0, 0, 1, 1).data)
      }
      function luminance(channels: number[]) {
        const [r, g, b] = channels.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      return links.map((link) => {
        let background = [255, 255, 255]
        const ancestors: Element[] = []
        for (let node: Element | null = link; node; node = node.parentElement) ancestors.unshift(node)
        for (const node of ancestors) {
          const [r, g, b, a] = rgb(getComputedStyle(node).backgroundColor)
          background = [r, g, b].map((value, i) => value * a / 255 + background[i] * (1 - a / 255))
        }
        const label = link.querySelector("span.text-xs")!
        const fg = luminance(rgb(getComputedStyle(label).color).slice(0, 3))
        const bg = luminance(background)
        return { status: link.getAttribute("data-thread-status"), ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) }
      })
    })
    for (const { status, ratio } of contrast) expect(ratio, `${theme} ${status} text contrast`).toBeGreaterThanOrEqual(4.5)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.screenshot({ path: `test-results/thread-status-${theme}.png`, fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.getByRole("link", { name: /压缩长期研究任务/ }).locator(".truncate")).toHaveCSS("text-overflow", "ellipsis")
    await page.screenshot({ path: `test-results/thread-status-mobile-${theme}.png`, fullPage: true })
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 800 })
  }
})
