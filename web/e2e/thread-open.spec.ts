import { expect, test } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"

// A Thread opened straight from its URL has no Thread List row to render from, so the
// first render is the loading placeholder and the detail read only lands on a later
// render. Every hook of the conversation has to run before that placeholder returns;
// anything below it is called one render later and React throws #310 ("Rendered more
// hooks than during the previous render"), which kills the column instead of opening it.
test("a Thread opened from its URL survives the loading placeholder", async ({ page }) => {
  const fixture = await stubWorkspace(page, { language: "zh", theme: "light" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/#/threads/created-thread")
  await expect(page).toHaveURL(/#\/threads\/created-thread/)
  await expect(page.getByRole("heading", { name: "Fixture conversation" })).toBeVisible()
  await expect(page.getByText("这个线程还没有消息。")).toBeVisible()
  await expect(page.getByPlaceholder("继续描述你的需求…")).toBeVisible()
  expect(fixture.unexpected).toEqual([])
})
