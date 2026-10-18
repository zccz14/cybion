import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

const now = Math.floor(Date.now() / 1000)
const notes = [
  { id: "aaaaaaaa", thread_id: null, thread_title: null, text: "交 11 月房租", created_at: now - 3 * 86400, done_at: null },
  { id: "bbbbbbbb", thread_id: "created-thread", thread_title: "Fixture conversation", text: "确认 GRID 解耦是否生效", created_at: now, done_at: null },
  { id: "cccccccc", thread_id: null, thread_title: null, text: "已经划掉的事", created_at: now, done_at: now },
]

test("notes group by scope, cross out, tear off, and add a global note", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light", notes })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("便签")

  // Global notes first, then the Thread that still holds one.
  await expect(page.getByRole("heading", { name: "全局", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "打开线程" })).toBeVisible()
  await expect(page.getByText("交 11 月房租")).toBeVisible()
  await expect(page.getByText("确认 GRID 解耦是否生效")).toBeVisible()
  // A crossed note keeps its text, struck through, in the collapsed section.
  await expect(page.locator('[data-slot="card-title"]', { hasText: "已划掉" })).toBeVisible()
  await expect(page.getByText("已经划掉的事")).toBeVisible()
  // Three days old: the age shows; a note added today shows none.
  await expect(page.getByText("3 天")).toBeVisible()

  await page.getByRole("button", { name: "划掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path === "/api/notes/aaaaaaaa/done").length).toBe(1)
  await expect(page.locator("p.line-through", { hasText: "交 11 月房租" })).toBeVisible()

  await page.getByRole("button", { name: "撕掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path.startsWith("/api/notes/")).length).toBe(2)

  await page.getByRole("textbox", { name: "添加便签" }).fill("买牛奶")
  await page.getByRole("button", { name: "添加便签", exact: true }).click()
  await expect.poll(() => fixture.writes.find((write) => write.path === "/api/notes" && (write.body as { text?: string }).text === "买牛奶") !== undefined).toBe(true)
  await expect(page.getByText("买牛奶")).toBeVisible()
  expect(fixture.unexpected).toEqual([])
})

test("notes stay readable in English, dark mode and a narrow window", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "en", theme: "dark", notes })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("Notes")
  await expect(page.getByRole("heading", { name: "Global", exact: true })).toBeVisible()
  await expect(page.locator('[data-slot="card-title"]', { hasText: "Crossed out" })).toBeVisible()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await expect(page.getByRole("button", { name: "Cross out", exact: true }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Tear off", exact: true }).first()).toBeVisible()
  await page.screenshot({ path: "test-results/notes-mobile.png", fullPage: true })
  expect(fixture.unexpected).toEqual([])
})
