import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

const now = Math.floor(Date.now() / 1000)
const writing = now - 3 * 86400
const notes = [
  { id: "aaaaaaaa", thread_id: "created-thread", thread_title: "Fixture conversation", text: "交 11 月房租", created_at: writing, done_at: null },
  { id: "bbbbbbbb", thread_id: "other-thread", thread_title: "Another conversation", text: "确认 GRID 解耦是否生效", created_at: now, done_at: null },
  { id: "cccccccc", thread_id: "created-thread", thread_title: "Fixture conversation", text: "已经划掉的事", created_at: now, done_at: now },
]
// The page prints absolute timestamps in the UI language; the machine-readable
// `datetime` attribute is what a test can pin down in any locale.
const stamp = (seconds: number) => new Date(seconds * 1000).toISOString()

test("notes show their whole record, the Thread they belong to, cross out and tear off", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light", notes })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("便签")

  // One group per Thread that still holds a note, headed by a link into it.
  await expect(page.getByRole("link", { name: "Fixture conversation" }).first()).toBeVisible()
  await expect(page.getByRole("link", { name: "Another conversation" }).first()).toBeVisible()
  await expect(page.getByText("交 11 月房租")).toBeVisible()
  await expect(page.getByText("确认 GRID 解耦是否生效")).toBeVisible()

  // Every note states when it was written, and the crossed one also states when it
  // was crossed out: three creations plus one crossing.
  await expect(page.locator("time[datetime]")).toHaveCount(4)
  await expect(page.locator(`time[datetime="${stamp(writing)}"]`)).toHaveCount(1)
  await expect(page.locator(`time[datetime="${stamp(now)}"]`)).toHaveCount(3)
  await expect(page.getByText("创建于").first()).toBeVisible()
  await expect(page.getByText("划掉于").first()).toBeVisible()

  // The crossed note keeps its text, struck through, in its own section, and still
  // says which Thread wrote it: the group link plus this one.
  await expect(page.locator('[data-slot="card-title"]', { hasText: "已划掉" })).toBeVisible()
  await expect(page.locator("p.line-through", { hasText: "已经划掉的事" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Fixture conversation" })).toHaveCount(2)
  // Notes are written by Threads, so the page offers no way to add one.
  await expect(page.getByRole("textbox")).toHaveCount(0)

  await page.getByRole("button", { name: "划掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path.endsWith("/done")).length).toBe(1)
  await expect(page.locator("p.line-through", { hasText: "交 11 月房租" })).toBeVisible()
  await expect(page.locator("time[datetime]")).toHaveCount(5)

  await page.getByRole("button", { name: "撕掉", exact: true }).first().click()
  await expect.poll(() => fixture.writes.filter((write) => write.path.startsWith("/api/notes/")).length).toBe(2)
  expect(fixture.unexpected).toEqual([])
})

test("notes stay readable in English, dark mode and a narrow window", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "en", theme: "dark", notes })
  await page.goto("/#/notes")
  await expect(page.locator(".ux-app-header__title")).toHaveText("Notes")
  await expect(page.getByRole("link", { name: "Fixture conversation" }).first()).toBeVisible()
  await expect(page.locator('[data-slot="card-title"]', { hasText: "Crossed out" })).toBeVisible()
  await expect(page.locator("time[datetime]")).toHaveCount(4)
  await expect(page.getByText("Created").first()).toBeVisible()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
  await expect(page.getByRole("button", { name: "Cross out", exact: true }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "Tear off", exact: true }).first()).toBeVisible()
  await page.screenshot({ path: "test-results/notes-mobile.png", fullPage: true })
  expect(fixture.unexpected).toEqual([])
})
