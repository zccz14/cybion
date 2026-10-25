import { expect, test } from "@playwright/test"

test("math renders through KaTeX with its own typography and MathML", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/katex.html")

  const inline = page.locator("[data-message='inline']")
  await expect(inline.getByRole("heading", { name: /质能方程/ })).toBeVisible()
  const katex = inline.locator(".katex").first()
  await expect(katex).toBeVisible()
  await expect(inline.locator(".katex")).toHaveCount(3)
  // 公式没有带上 KaTeX 的样式表时字体会退回 Times New Roman，这里顺便验证 CSS 已经随组件加载。
  expect(await katex.evaluate((node) => getComputedStyle(node).fontFamily)).toContain("KaTeX_Main")
  await expect(inline.locator(".katex-mathml math")).toHaveCount(3)
  await expect(inline.locator(".katex-html[aria-hidden='true']")).toHaveCount(3)
  const loadedFonts = await page.evaluate(async () => {
    await document.fonts.ready
    return [...document.fonts].filter((font) => font.family.startsWith("KaTeX") && font.status === "loaded").length
  })
  expect(loadedFonts).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test("display math is a centered block and stays inside the transcript at narrow widths", async ({ page }) => {
  await page.goto("/e2e/katex.html")
  const display = page.locator("[data-message='display'] .katex-display")
  await expect(display).toBeVisible()
  await expect(display).toHaveCSS("display", "block")
  await expect(display.locator(".katex-mathml math")).toHaveCount(1)
  expect(await display.evaluate((node) => getComputedStyle(node).textAlign)).toBe("center")

  const wide = page.locator("[data-message='wide'] .katex-display")
  await expect(wide).toBeVisible()
  await expect(wide).toHaveCSS("overflow-x", "auto")
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await wide.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
})

test("broken math degrades to a titled error span and escapes keep dollars literal", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/katex.html")

  const broken = page.locator("[data-message='broken']")
  const error = broken.locator(".katex-error")
  await expect(error).toBeVisible()
  await expect(error).toHaveAttribute("title", /KaTeX/)
  await expect(broken).toContainText("仍然要作为文本出现")
  await expect(broken).toContainText("后面的句子照常可读")

  const escaped = page.locator("[data-message='escaped']")
  await expect(escaped).toContainText("预算 $5 与 $10")
  await expect(escaped.locator(".katex")).toHaveCount(0)

  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await expect(page.locator("html")).toHaveClass("dark")
  expect(await error.evaluate((node) => getComputedStyle(node).color)).toBe("oklch(0.704 0.191 22.216)")
  expect(errors).toEqual([])
})

test("model-style backslash delimiters render as math in both kinds", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/katex.html")

  const message = page.locator("[data-message='backslash']")
  await expect(message).toContainText("可以先检验状态依赖的概率收缩")
  const display = message.locator(".katex-display")
  await expect(display).toHaveCount(1)
  await expect(display.locator(".katex-mathml math[display='block']")).toHaveCount(1)
  await expect(display).toHaveCSS("display", "block")
  // 行内 \(T(s)\) 与 \(\mu\) 各自渲染，说明文本里不再残留反斜杠分隔符。
  await expect(message.locator("p .katex")).toHaveCount(2)
  await expect(message.locator(".katex-error")).toHaveCount(0)
  await expect(message).not.toContainText("[ p=")
  await expect(message).not.toContainText("\\(")
  expect(errors).toEqual([])

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await display.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})
