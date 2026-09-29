import { expect, test } from "@playwright/test"

test("search filters threads and reports empty results with a reset", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await expect(page.getByRole("link")).toHaveCount(3)
  await page.getByRole("searchbox").fill("worker")
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Worker 配对与导航")
  await page.getByRole("searchbox").fill("bridge")
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Worker 配对与导航")
  await page.getByRole("searchbox").fill("没有这个线程")
  await expect(page.getByRole("link")).toHaveCount(0)
  await expect(page.getByText("没有匹配的线程")).toBeVisible()
  await page.getByRole("button", { name: "回到「全部」" }).click()
  await expect(page.getByRole("searchbox")).toHaveValue("")
  await expect(page.getByRole("link")).toHaveCount(3)
})

test("view chips switch between all, mine, api, running, and failed", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await page.getByRole("button", { name: "我的" }).click()
  await expect(page.getByRole("button", { name: "我的" })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("link")).toHaveCount(2)
  await expect(page.getByRole("link", { name: /Worker 配对与导航/ })).toHaveCount(0)
  await page.getByRole("searchbox").fill("search")
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Mobile thread list search")
  await page.getByRole("searchbox").fill("")
  await expect(page.getByRole("link")).toHaveCount(2)
  await page.getByRole("button", { name: "API" }).click()
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Worker 配对与导航")
  await page.getByRole("button", { name: "运行中" }).click()
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("Worker 配对与导航")
  await page.getByRole("button", { name: "失败" }).click()
  await expect(page.getByRole("link")).toHaveCount(1)
  await expect(page.getByRole("link")).toContainText("检查远程服务器连接")
  await expect(page.getByRole("button", { name: "已归档 (1)" })).toBeVisible()
  await page.getByRole("button", { name: "全部" }).click()
  await expect(page.getByRole("link")).toHaveCount(3)
})

test("more threads load when the list footer scrolls into view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 300 })
  await page.goto("/e2e/thread-list.html?paged=1")
  await expect(page.getByRole("link")).toHaveCount(3)
  await page.getByRole("button", { name: "加载更多" }).scrollIntoViewIfNeeded()
  await expect(page.getByRole("link")).toHaveCount(5)
  await expect(page.getByRole("link", { name: /Older thread B/ })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "加载更多" })).toHaveCount(0)
})

test("integration-created rows show their API origin chip", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await expect(page.getByRole("link", { name: /修复 Worker 配对与导航/ }).getByText("API", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: /检查远程服务器连接/ }).getByText("API", { exact: true })).toHaveCount(0)
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
        await expect(page.getByRole("searchbox")).toHaveAttribute("placeholder", language === "en" ? "Search titles or external refs" : "搜索标题或外部引用")
        await expect(page.getByRole("link")).toHaveCount(3)
      }
    }
  }
  await page.screenshot({ path: "test-results/thread-list-mobile.png" })
})

test("archived threads stay hidden until their group expands, then restore in place", async ({ page }) => {
  await page.goto("/e2e/thread-list.html")
  await expect(page.getByRole("link")).toHaveCount(3)
  await expect(page.getByRole("link", { name: /Legacy thread archive/ })).toHaveCount(0)
  await page.getByRole("button", { name: "已归档 (1)" }).click()
  await expect(page.getByRole("link")).toHaveCount(4)
  await expect(page.getByRole("link", { name: /Legacy thread archive/ })).toBeVisible()
  await page.getByRole("button", { name: "恢复" }).click()
  await expect(page.getByTestId("restored")).toHaveText("legacy")
  await expect(page.getByRole("link")).toHaveCount(3)
  await expect(page.getByRole("button", { name: "已归档 (1)" })).toHaveCount(0)
})
