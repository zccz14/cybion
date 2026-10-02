import { test, expect, type Page, type Route } from "@playwright/test"
import type { ThreadGrant } from "../src/lib/thread-sharing"
const id = "00000000-0000-4000-8000-000000000001"
const apiPath = `/api/shared-threads/remote-owner/${id}`
const routePath = `/shared-threads/remote-owner/${id}`
const shot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OZ0AAAAASUVORK5CYII="
function record(n: number, kind: string, payload: unknown) { return { id: n, thread_id: id, kind, payload, created_at: 1_800_000_000 + n } }
async function fixture(page: Page) {
  const calls: { path: string; method: string; session: string; body: string | null }[] = []
  const state = { allowed: true, paged: false, sync: false, hidden: false, fail: "", extra: false, generation: "g1", held: null as Route | null, holdOlder: false }
  let grants: ThreadGrant[] = []
  const thread = () => ({ id, owner_user_id: "remote-owner", grant_id: state.generation, access: "viewer", title: "Owner's private task", status: "running", display_status: "running", usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, cached_tokens: 0, cache_hit_rate: 0 }, created_at: 1, updated_at: 2, shared_at: 3 })
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const session = request.headers()["x-fixture-session"]
    calls.push({ path: url.pathname + url.search, method: request.method(), session, body: request.postData() })
    if (state.fail && path.endsWith(state.fail)) return route.fulfill({ status: 503, json: { error: "Source temporarily unavailable" } })
    if (path === `/api/threads/${id}/grants`) return route.fulfill({ json: session === "session-2" ? [] : grants.map((g) => ({ ...g, synced_revision: state.sync ? g.revision : g.synced_revision })) })
    if (path.startsWith(`/api/threads/${id}/grants/`)) {
      if (request.method() === "PUT") {
        const g: ThreadGrant = { grantee_user_id: path.split("/").at(-1)!, grant_id: "g1", permission: "viewer", revoked_at: null, revision: 1, synced_revision: 0, created_at: 1, updated_at: 1 }
        grants = [g]; return route.fulfill({ json: g })
      }
      grants = grants.map((g) => ({ ...g, revoked_at: 2, revision: 2, synced_revision: 1 })); state.sync = false
      return route.fulfill({ status: 204 })
    }
    if (path === "/api/shared-threads") {
      if (state.paged && !url.searchParams.has("cursor")) return route.fulfill({ json: { items: [], next_cursor: "fixture-next-page" } })
      const visible = state.allowed && session === "session-1" && (url.searchParams.get("hidden") === "true") === state.hidden
      return route.fulfill({ json: { items: visible ? [thread()] : [], next_cursor: null } })
    }
    if (!state.allowed || session === "session-2") return route.fulfill({ status: 404, json: { error: "Shared Thread unavailable" } })
    if (path === apiPath) return route.fulfill({ json: thread() })
    if (path === `${apiPath}/visibility`) { state.hidden = JSON.parse(request.postData()!).hidden; return route.fulfill({ status: 204 }) }
    if (path === `${apiPath}/history/window`) {
      if (url.searchParams.has("before")) {
        if (state.holdOlder) { state.held = route; return }
        return route.fulfill({ json: { has_older: false, records: [record(1, "input", { role: "user", content: "Earlier original question" }), record(2, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] })] } })
      }
      return route.fulfill({ json: { has_older: true, records: [record(10, "input", { role: "user", content: "Latest original question" }), { ...record(11, "tool_output", { type: "function_call_output", call_id: "shot", output: JSON.stringify({ data: shot }) }), screenshot: true }, record(12, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved answer" }] })] } })
    }
    if (path === `${apiPath}/history`) return route.fulfill({ json: state.extra && Number(url.searchParams.get("after")) < 13 ? [record(13, "response_output", { type: "message", role: "assistant", content: [{ type: "output_text", text: "New owner update" }] })] : [] })
    if (path === `${apiPath}/response`) return route.fulfill({ json: { started_at: 1_800_000_012, status: "in_flight", response: { completed: false, output: [{ item: { type: "message", id: "live", role: "assistant", content: [{ type: "output_text", text: "Streaming owner reply" }] }, done: false, record_id: null }] } } })
    return route.fulfill({ status: 403, json: { error: `Unexpected ${path}` } })
  })
  return { state, calls }
}

test("owner explicitly consents, copies identity link, tracks sync and revokes", async ({ page, context }) => {
  const { state, calls } = await fixture(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await page.goto("/e2e/thread-sharing.html#/owner")
  await page.getByRole("button", { name: "Share Thread", exact: true }).click()
  const dialog = page.getByRole("dialog")
  const grant = dialog.getByRole("button", { name: "Authorize viewing" })
  await expect(grant).toBeDisabled()
  await dialog.getByRole("textbox").fill("user-1")
  await expect(dialog).toContainText("You already own this Thread")
  await dialog.getByRole("textbox").fill(" recipient ")
  await expect(dialog).toContainText("without spaces")
  await dialog.getByRole("textbox").fill("recipient")
  await expect(grant).toBeDisabled()
  await dialog.getByRole("checkbox").check()
  await expect(dialog).toContainText("future updates")
  await expect(dialog).toContainText("not automatically redacted")
  await grant.click()
  await expect(dialog).toContainText("Authorized; list sync pending")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("button", { name: "Shared · 1", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Shared · 1", exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Shared · 1", exact: true }).click()
  expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1)
  state.sync = true
  await expect(dialog.getByText("Authorized; list sync pending")).toHaveCount(0)
  await dialog.getByRole("button", { name: "Copy access link" }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`#\\/shared-threads\\/user-1\\/${id}$`))
  page.once("dialog", async (d) => { expect(d.message()).toContain("cannot be recalled"); expect(d.message()).toContain("running task will continue"); await d.accept() })
  await dialog.getByRole("button", { name: "Revoke access" }).click()
  await expect(dialog.getByText("Revoked", { exact: true })).toBeVisible()
  await expect(dialog).toContainText("Revoked; list sync pending")
})

test("viewer reads history, screenshots and live updates without any execution or resource requests", async ({ page }) => {
  const { state, calls } = await fixture(page)
  await page.goto(`/e2e/thread-sharing.html#${routePath}`)
  await expect(page.getByRole("heading", { name: "Owner's private task" })).toBeVisible()
  await expect(page.getByText("Read only", { exact: true })).toBeVisible()
  await expect(page.getByText("Latest original question", { exact: true })).toBeVisible()
  await expect(page.getByText("Streaming owner reply", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Load earlier messages" }).click()
  await expect(page.getByText("Earlier original question", { exact: true })).toBeAttached()
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0)
  state.extra = true
  await expect(page.getByText("New owner update", { exact: true })).toBeAttached()
  await page.locator("summary").filter({ hasText: "Ran for" }).click()
  await expect(page.locator('img[src^="data:image/png"]')).toHaveCount(1)
  await page.getByRole("checkbox", { name: "Minimal view (only for me)" }).check()
  await expect(page.getByRole("textbox")).toHaveCount(0)
  for (const label of ["Send", "Stop", "Continue", "Compact", "Delete", "Rename", "Share Thread"]) await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0)
  expect(calls.every((c) => c.path.startsWith(apiPath) && c.method === "GET")).toBe(true)
})

test("revocation aborts a pending page, clears cached content, stops polling and supports a fresh regrant", async ({ page }) => {
  const { state, calls } = await fixture(page)
  await page.goto(`/e2e/thread-sharing.html#${routePath}`)
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
  state.holdOlder = true
  await page.getByRole("button", { name: "Load earlier messages" }).click()
  await expect.poll(() => state.held !== null).toBe(true)
  state.allowed = false
  await expect(page.getByText(/This Thread is unavailable/)).toBeVisible()
  await expect(page.getByText("Owner's private task", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Saved answer", { exact: true })).toHaveCount(0)
  await state.held!.fulfill({ json: { records: [record(1, "input", { content: "Late private page" })], has_older: false } }).catch(() => {})
  const count = calls.length
  await page.waitForTimeout(2000)
  expect(calls.length).toBe(count)
  await expect(page.getByText("Late private page", { exact: true })).toHaveCount(0)
  const cache = await page.evaluate("window.sharingFixtureCache()")
  expect(JSON.stringify(cache)).not.toContain("Saved answer")
  expect(JSON.stringify(cache)).not.toContain("Owner's private task")
  state.allowed = true; state.generation = "g2"; state.holdOlder = false
  await page.getByRole("button", { name: "Check access again" }).click()
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
})

test("account switches and temporary source failures never render previous private content", async ({ page }) => {
  const { state } = await fixture(page)
  await page.goto(`/e2e/thread-sharing.html#${routePath}`)
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
  state.fail = id
  await expect(page.getByText("Source temporarily unavailable", { exact: true })).toBeVisible()
  await expect(page.getByText("Saved answer", { exact: true })).toHaveCount(0)
  state.fail = ""
  await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Switch account" }).click()
  await expect(page.getByText(/This Thread is unavailable/)).toBeVisible()
  await expect(page.getByText("Saved answer", { exact: true })).toHaveCount(0)
  expect(JSON.stringify(await page.evaluate("window.sharingFixtureCache()"))).not.toContain("Saved answer")
})

test("shared discovery exposes stable UID and hiding only changes the recipient list", async ({ page }) => {
  const { calls } = await fixture(page)
  await page.goto("/e2e/thread-sharing.html#/shared-threads")
  await expect(page.getByRole("region", { name: "My user ID" })).toContainText("user-1")
  await page.getByRole("button", { name: "Hide from my list" }).click()
  await expect(page.getByRole("link", { name: "Owner's private task" })).toHaveCount(0)
  await page.getByRole("button", { name: "Hidden shares" }).click()
  await expect(page.getByRole("link", { name: "Owner's private task" })).toBeVisible()
  await page.getByRole("button", { name: "Restore to my list" }).click()
  await expect(page.getByRole("link", { name: "Owner's private task" })).toHaveCount(0)
  await page.getByRole("button", { name: "Visible shares" }).click()
  await page.getByRole("link", { name: "Owner's private task" }).click()
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
  expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([`${apiPath}/visibility`, `${apiPath}/visibility`])
})

test("sharing surfaces fit mobile, dark mode and both languages", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/e2e/thread-sharing.html#${routePath}`)
  await expect(page.getByText("Saved answer", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await expect(page.getByText("只读", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/thread-sharing-viewer-mobile-dark.png", fullPage: true })
  await page.goto("/e2e/thread-sharing.html#/owner")
  await page.getByRole("button", { name: "分享 Thread", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/thread-sharing-owner-mobile.png", fullPage: true })
})


test("short discovery pages keep their continuation and unauthorized links never mount content", async ({ page }) => {
  const { state, calls } = await fixture(page)
  state.paged = true
  await page.goto("/e2e/thread-sharing.html#/shared-threads")
  await expect(page.getByText("No accessible shares on this page. Load more to continue.")).toBeVisible()
  await page.getByRole("button", { name: "Load more", exact: true }).click()
  await expect(page.getByRole("link", { name: "Owner's private task" })).toBeVisible()
  expect(calls.some((c) => c.path.includes("cursor=fixture-next-page"))).toBe(true)
  state.allowed = false
  const before = calls.length
  await page.goto(`/e2e/thread-sharing.html#${routePath}`)
  await expect(page.getByText(/This Thread is unavailable/)).toBeVisible()
  await expect(page.getByText("Owner's private task", { exact: true })).toHaveCount(0)
  expect(calls.slice(before).some((c) => c.path.includes("/history") || c.path.includes("/response"))).toBe(false)
})
