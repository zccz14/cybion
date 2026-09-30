import { expect, test } from "@playwright/test"

const chartDiagram = "[data-message='chart'] [data-mermaid='diagram'] svg"

test("mermaid blocks render as diagrams, follow the theme, and fall back to source while invalid", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  await page.goto("/e2e/mermaid.html")

  const chart = page.locator("[data-message='chart']")
  const diagram = chart.locator("[data-mermaid='diagram'] svg")
  await expect(diagram).toBeVisible()
  await expect(chart.locator("[data-mermaid='source']")).toHaveCount(0)
  await expect(diagram.locator(".node rect").first()).toHaveCSS("stroke", "rgb(153, 153, 153)")

  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await expect(diagram.locator(".node rect").first()).toHaveCSS("stroke", "rgb(204, 204, 204)")
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await expect(diagram.locator(".node rect").first()).toHaveCSS("stroke", "rgb(153, 153, 153)")

  const stream = page.locator("[data-message='stream']")
  const source = stream.locator("pre[data-mermaid='source'] code.language-mermaid")
  await expect(source).toBeVisible()
  await expect(source).toContainText("graph TD")
  await expect(stream.locator("[data-mermaid='diagram']")).toHaveCount(0)
  await page.getByRole("button", { name: "Complete", exact: true }).click()
  await expect(stream.locator("[data-mermaid='diagram'] svg")).toBeVisible()
  await expect(stream.locator("[data-mermaid='source']")).toHaveCount(0)
  await page.getByRole("button", { name: "Complete", exact: true }).click()
  await expect(source).toBeVisible()

  const snippet = page.locator("[data-message='snippet']")
  await expect(snippet.locator("pre code.language-ts")).toHaveText("const answer = 42")
  await expect(snippet.locator("svg")).toHaveCount(0)

  expect(errors).toEqual([])
})

test("a page that starts in dark mode renders dark diagrams", async ({ page }) => {
  await page.goto("/e2e/mermaid.html?theme=dark")
  await expect(page.locator("html")).toHaveClass("dark")
  await expect(page.locator(chartDiagram).locator(".node rect").first()).toHaveCSS("stroke", "rgb(204, 204, 204)")
  await expect(page.locator(chartDiagram).locator(".node rect").first()).toHaveCSS("fill", "rgb(31, 32, 32)")
})

test("diagrams stay within narrow layouts in both themes", async ({ page }) => {
  await page.goto("/e2e/mermaid.html")
  await expect(page.locator(chartDiagram)).toBeVisible()
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await page.getByRole("button", { name: "Theme", exact: true }).click()
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }
})
