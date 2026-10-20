import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

const now = Math.floor(Date.now() / 1000)
const notes = [
  { id: "aaaaaaaa", thread_id: "created-thread", thread_title: "Fixture conversation", text: "交 11 月房租", created_at: now - 3 * 86400, done_at: null },
  { id: "bbbbbbbb", thread_id: "other-thread", thread_title: "Another conversation", text: "确认 GRID 解耦是否生效", created_at: now, done_at: null },
  { id: "cccccccc", thread_id: "created-thread", thread_title: "Fixture conversation", text: "已经划掉的事", created_at: now, done_at: now },
]

test("notes group by Thread, cross out, and tear off, and the page never writes one", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light", notes })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("便签")

  // One group per Thread that still holds a note, each with a link back.
  await expect(page.getByRole("heading", { name: "Fixture conversation", exact: true })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Another conversation", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "打开线程" })).toHaveCount(2)
  await expect(page.getByText("交 11 月房租")).toBeVisible()
  await expect(page.getByText("确认 GRID 解耦是否生效")).toBeVisible()
  // A crossed note keeps its text, struck through, in the collapsed section.
  await expect(page.locator('[data-slot="card-title"]', { hasText: "已划掉" })).toBeVisible()
  await expect(page.getByText("已经划掉的事")).toBeVisible()
  // Three days old: the age shows; a note added today shows none.
  await expect(page.getByText("3 天")).toBeVisible()
  // Notes are written by Threads, so the page offers no way to add one.
  await expect(page.getByRole("textbox")).toHaveCount(0)

  await page.getByRole("button", { name: "划掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path.endsWith("/done")).length).toBe(1)
  await expect(page.locator("p.line-through", { hasText: "交 11 月房租" })).toBeVisible()

  await page.getByRole("button", { name: "撕掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path.startsWith("/api/notes/")).length).toBe(2)
  expect(fixture.unexpected).toEqual([])
})

test("notes stay readable in English, dark mode and a narrow window", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "en", theme: "dark", notes })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("Notes")
  await expect(page.getByRole("heading", { name: "Fixture conversation", exact: true })).toBeVisible()
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
