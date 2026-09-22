import { expect, test } from "@playwright/test"

test("search filters thread titles and reports empty results", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await expect(page.getByRole("link")).toHaveCount(3)
  await page.getByRole("searchbox").fill("worker")
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Worker 配对与导航")
  await page.getByRole("searchbox").fill("没有这个线程")
  await expect(page.getByRole("link")).toHaveCount(0)
  await expect(page.getByText("没有匹配的线程")).toBeVisible()
  await page.getByRole("searchbox").fill("")
  await expect(page.getByRole("link")).toHaveCount(3)
})

test("the new thread action stays reachable next to the search field", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await page.getByRole("button", { name: "新建线程" }).click()
  await expect(page.getByTestId("created")).toHaveText("1")
})

test("rows stay within narrow light and dark layouts in both languages", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark)
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await expect(page.getByRole("searchbox")).toHaveAttribute("placeholder", language === "en" ? "Search thread titles" : "搜索线程标题")
        await expect(page.getByRole("link")).toHaveCount(3)
      }
    }
  }
  await page.screenshot({ path: "test-results/thread-list-mobile.png" })
})
