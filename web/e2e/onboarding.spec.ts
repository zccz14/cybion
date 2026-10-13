import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

test("a real new workspace opens the mobile composer and examples never send automatically", async ({ page }) => {
  const fixture = await stubWorkspace(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/#/threads")
  const input = page.getByRole("textbox", { name: "你希望 Cybion 处理什么？" })
  await expect(input).toBeVisible()
  await expect(input).toBeInViewport()
  await page.screenshot({ path: "test-results/onboarding-mobile-empty.png", fullPage: true })
  await expect(page.getByRole("heading", { name: "新建对话", exact: true })).toBeVisible()
  expect(fixture.requests).toContain("/api/threads?limit=1")
  await page.getByRole("button", { name: "把想法整理成计划" }).click()
  await expect(input).toHaveValue(/可执行的计划/)
  await expect(input).toBeFocused()
  expect(fixture.writes.filter((entry) => entry.path === "/api/threads/start")).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/onboarding-first-conversation-mobile.png", fullPage: true })
  await input.fill("帮我整理一个计划")
  await page.getByRole("button", { name: "开始对话", exact: true }).click()
  await expect(page).toHaveURL(/#\/threads\/created-thread/)
  expect(fixture.writes.filter((entry) => entry.path === "/api/threads/start")).toHaveLength(1)
  expect(fixture.unexpected).toEqual([])
})

for (const scenario of ["api-only", "archived", "search", "failed-filter", "unknown-count"] as const) {
  test(`${scenario} is not mistaken for a new workspace`, async ({ page }) => {
    const fixture = await stubWorkspace(page, { activeTotal: scenario === "api-only" || scenario === "search" ? 2 : 0, webTotal: 0, archivedTotal: scenario === "archived" ? 1 : 0, countFails: scenario === "unknown-count" })
    await page.setViewportSize({ width: 390, height: 844 })
    const query = scenario === "search" ? "?q=missing" : scenario === "failed-filter" ? "?view=failed" : ""
    await page.goto(`/#/threads${query}`)
    await expect(page.getByRole("button", { name: "新建对话", exact: true })).toBeVisible()
    await expect(page.getByText("没有匹配的对话", { exact: true })).toBeVisible()
    if (scenario === "api-only" || scenario === "unknown-count") await expect.poll(() => fixture.requests.includes("/api/threads?limit=1")).toBe(true)
    await expect(page.locator("#new-thread-input")).toHaveCount(0)
    if (scenario === "search" || scenario === "failed-filter" || scenario === "archived") expect(fixture.requests).not.toContain("/api/threads?limit=1")
    await page.getByRole("button", { name: "新建对话", exact: true }).click()
    await expect(page.locator("#new-thread-input")).toBeVisible()
    expect(fixture.unexpected).toEqual([])
  })
}

for (const [language, theme] of [["zh", "light"], ["en", "dark"]] as const) {
  test(`context onboarding and accessible help work in ${language}/${theme}`, async ({ page }) => {
    const fixture = await stubWorkspace(page, { language, theme })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto("/#/contexts")
    await expect(page.locator(".ux-app-header__title")).toHaveText(language === "zh" ? "上下文" : "Contexts")
    await expect(page.locator('input[type="file"]')).toHaveCount(0)
    if (theme === "dark") await expect(page.locator("html")).toHaveClass("dark")
    else await expect(page.locator("html")).not.toHaveClass("dark")
    await page.screenshot({ path: `test-results/onboarding-context-empty-${language}-${theme}.png`, fullPage: true })
    await page.getByRole("button", { name: language === "zh" ? "什么是上下文？" : "What is a Context?", exact: true }).click()
    await expect(page.getByRole("dialog")).toContainText(language === "zh" ? "读取的内容仍可能进入" : "retrieved for a task")
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.setViewportSize({ width: 320, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole("button", { name: language === "zh" ? "新建上下文" : "New context", exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const editor = page.locator(".markdown-editor")
    await editor.getByRole("button", { name: language === "zh" ? "源码" : "Markdown", exact: true }).click()
    await editor.locator("textarea").fill("# My project\n\nRead README.md first.")
    await editor.getByRole("button", { name: language === "zh" ? "编辑" : "Write", exact: true }).click()
    await expect(editor.locator("textarea")).toHaveCount(0)
    await expect(editor.locator(".markdown-editor__canvas h1")).toHaveText("My project")
    expect(fixture.references).toHaveLength(0)
    await page.getByLabel(language === "zh" ? "上下文名称" : "Context name", { exact: true }).fill("My project")
    await page.getByRole("button", { name: language === "zh" ? "创建上下文" : "Create context", exact: true }).click()
    // deletion now sits next to the editor heading; the old
    // use-in-conversation block and its seeded draft are gone
    await expect(page.locator("main > section h2")).toHaveText("My project")
    await expect(page.getByRole("button", { name: language === "zh" ? "重命名" : "Rename", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: language === "zh" ? "删除上下文" : "Delete context", exact: true })).toBeVisible()
    await expect(page.getByRole("link", { name: /在对话中使用|Use in a conversation/ })).toHaveCount(0)
    expect(fixture.references).toHaveLength(1)
    expect(fixture.references[0].content).toContain("# My project")
    await page.screenshot({ path: `test-results/onboarding-context-${language}-${theme}.png`, fullPage: true })
    expect(fixture.writes.filter((entry) => entry.path === "/api/threads/start")).toHaveLength(0)
    await page.goto("/#/help")
    await expect(page.getByRole("heading", { name: language === "zh" ? "使用帮助" : "Using Cybion", exact: true })).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 1000 })
    await page.screenshot({ path: `test-results/onboarding-help-desktop-${language}-${theme}.png`, fullPage: true })
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.screenshot({ path: `test-results/onboarding-help-${language}-${theme}.png`, fullPage: true })
    expect(fixture.unexpected).toEqual([])
  })
}

test("model initialization failure exposes repair without blocking a configured fallback or static help", async ({ page }) => {
  const fixture = await stubWorkspace(page, { connectionFails: true, fallbackReady: true })
  await page.goto("/#/threads/new")
  await expect(page.getByText("默认模型连接未能准备完成。", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "检查模型设置", exact: true })).toHaveAttribute("href", "#/configuration")
  await page.locator("#new-thread-input").fill("Use my configured model")
  await expect(page.getByRole("button", { name: "开始对话", exact: true })).toBeEnabled()
  fixture.state.connectionFails = false
  await page.getByRole("button", { name: "重试连接", exact: true }).click()
  await expect(page.getByText("默认模型连接未能准备完成。", { exact: true })).toHaveCount(0)
  expect(fixture.writes.filter((entry) => entry.path === "/api/threads/start")).toHaveLength(0)
  fixture.state.connectionFails = true
  await page.goto("/#/help")
  await expect(page.getByRole("heading", { name: "使用帮助", exact: true })).toBeVisible()
  await expect(page.getByText("发送失败怎么办？", { exact: true })).toBeVisible()
  expect(fixture.unexpected).toEqual([])
})

test("device guidance is optional and security consent stays in the pairing flow", async ({ page }) => {
  const fixture = await stubWorkspace(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/#/workers")
  await expect(page.getByText(/普通对话不需要 Worker。需要读取设备文件/)).toBeVisible()
  await page.getByRole("button", { name: "什么是 Worker？", exact: true }).click()
  await expect(page.getByRole("dialog")).toContainText("并非每条命令都会再次请求确认")
  await page.keyboard.press("Escape")
  await expect(page.getByRole("link", { name: "开始对话", exact: true })).toBeVisible()
  expect(fixture.writes.filter((entry) => entry.path.includes("worker"))).toHaveLength(0)
  await page.screenshot({ path: "test-results/onboarding-device-mobile.png", fullPage: true })
  expect(fixture.unexpected).toEqual([])
})


test("a rejected first message keeps its draft and exposes model-setting recovery", async ({ page }) => {
  const fixture = await stubWorkspace(page, { startFails: true })
  await page.goto("/#/threads/new")
  await page.locator("#new-thread-input").fill("Keep this unsent request")
  await page.getByRole("button", { name: "开始对话", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("未能开始这段对话")
  await expect(page.getByRole("alert")).toContainText("Fixture: model access denied")
  await expect(page.getByRole("alert").getByRole("link", { name: "检查模型设置" })).toHaveAttribute("href", "#/configuration")
  await expect(page.locator("#new-thread-input")).toHaveValue("Keep this unsent request")
  expect(fixture.writes.filter((entry) => entry.path === "/api/threads/start")).toHaveLength(1)
  expect(fixture.unexpected).toEqual([])
})


test("repairing NormAI from settings clears the shared initialization warning", async ({ page }) => {
  const fixture = await stubWorkspace(page, { connectionFails: true })
  await page.goto("/#/threads/new")
  await expect(page.getByText("默认模型连接未能准备完成。", { exact: true })).toBeVisible()
  await page.getByRole("link", { name: "检查模型设置", exact: true }).click()
  await expect(page.getByRole("button", { name: "连接 NormAI", exact: true })).toBeVisible()
  fixture.state.connectionFails = false
  await page.getByRole("button", { name: "连接 NormAI", exact: true }).click()
  await expect(page.getByRole("button", { name: "重新签发密钥", exact: true })).toBeVisible()
  await page.locator('.ux-sidebar a[href="#/threads"]').click()
  await expect(page.locator("#new-thread-input")).toBeVisible()
  await expect(page.getByText("默认模型连接未能准备完成。", { exact: true })).toHaveCount(0)
  expect(fixture.unexpected).toEqual([])
})
