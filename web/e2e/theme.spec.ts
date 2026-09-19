import { expect, test, type Locator } from "@playwright/test"

async function readableNeutralText(locator: Locator) {
  const result = await locator.evaluate((element) => {
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
    let background = [255, 255, 255]
    const ancestors: Element[] = []
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node)
    for (const node of ancestors) {
      const [r, g, b, a] = rgb(getComputedStyle(node).backgroundColor)
      background = [r, g, b].map((value, i) => value * a / 255 + background[i] * (1 - a / 255))
    }
    const foreground = rgb(getComputedStyle(element).color).slice(0, 3)
    const fg = luminance(foreground), bg = luminance(background)
    return { foreground, background, contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) }
  })
  expect(result.contrast).toBeGreaterThanOrEqual(4.5)
  for (const channels of [result.foreground, result.background]) {
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(1)
  }
}

test("dark surfaces and actual Markdown are neutral, readable, and separate from white primary actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/e2e/theme.html#/threads/running")
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark")
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 18, 18)")
  await expect(page.getByTestId("user-message")).toHaveCSS("background-color", "rgb(38, 38, 38)")
  await expect(page.getByTestId("assistant-message")).toHaveCSS("background-color", "rgb(28, 28, 28)")
  await expect(page.getByTestId("reasoning")).toHaveCSS("background-color", "rgb(28, 28, 28)")
  await expect(page.getByTestId("reasoning")).toHaveCSS("border-top-color", "rgb(56, 56, 56)")
  await expect(page.getByTestId("send")).toHaveCSS("background-color", "rgb(229, 229, 229)")
  for (const locator of [page.getByTestId("user-message"), page.getByTestId("muted-text"), page.getByTestId("send"), ...await page.getByTestId("markdown").locator("h3, p, strong, a, code, li, th, td").all()]) {
    await readableNeutralText(locator)
  }
  await page.getByRole("combobox").click()
  await expect(page.getByRole("listbox")).toHaveCSS("background-color", "rgb(36, 36, 36)")
  await page.getByRole("option", { name: "High", exact: true }).hover()
  await expect(page.getByRole("option", { name: "High", exact: true })).toHaveCSS("background-color", "rgb(48, 48, 48)")
  await readableNeutralText(page.getByRole("option", { name: "High", exact: true }))
  await page.keyboard.press("Escape")
  await page.screenshot({ path: "test-results/neutral-dark-desktop.png", fullPage: true })
})

test("theme toggling restores the light palette and leaves status semantics intact", async ({ page }) => {
  await page.goto("/e2e/theme.html#/threads/running")
  const theme = page.getByRole("button", { name: "Switch theme", exact: true })
  await expect(page.locator("html")).toHaveClass("dark")
  await theme.click()
  await expect(page.locator("html")).not.toHaveClass("dark")
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light")
  const light = await page.getByTestId("user-message").evaluate((element) => {
    const styles = getComputedStyle(element)
    return { background: styles.backgroundColor, foreground: styles.color, primary: styles.getPropertyValue("--primary"), primaryForeground: styles.getPropertyValue("--primary-foreground") }
  })
  expect(light.background).toBe(light.primary)
  expect(light.foreground).toBe(light.primaryForeground)
  await page.screenshot({ path: "test-results/neutral-theme-light.png", fullPage: true })
  await theme.click()
  await expect(page.getByTestId("user-message")).toHaveCSS("background-color", "rgb(38, 38, 38)")
  for (const [status, color] of [["running", "rgb(252, 211, 77)"], ["completed", "rgb(110, 231, 183)"], ["failed", "rgb(252, 165, 165)"]]) {
    await expect(page.getByRole("navigation", { name: "Threads" }).locator(`[data-thread-status="${status}"] svg`)).toHaveCSS("color", color)
  }
})

test("keyboard focus, mobile drawer and narrow layout use the neutral theme", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/e2e/theme.html#/threads/running")
  await expect(page.locator("html")).toHaveClass("dark")
  const input = page.getByRole("textbox", { name: "Thread name", exact: true })
  await input.focus()
  await expect(input).toBeFocused()
  await expect(input).toHaveCSS("border-top-color", "rgb(212, 212, 212)")
  await expect(input).not.toHaveCSS("box-shadow", "none")
  await input.press("Tab")
  await expect(page.getByRole("combobox")).toBeFocused()
  await expect(page.getByRole("combobox")).toHaveCSS("border-top-color", "rgb(212, 212, 212)")
  await page.getByRole("button", { name: "Navigation", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCSS("background-color", "rgb(22, 22, 22)")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(page.getByRole("navigation", { name: "Threads" }).locator('[data-thread-status="running"] svg')).toHaveCSS("animation-name", "none")
  await page.screenshot({ path: "test-results/neutral-dark-mobile.png", fullPage: true })
})
