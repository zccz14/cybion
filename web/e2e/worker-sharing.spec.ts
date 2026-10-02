import { test, expect, type Page } from "@playwright/test"
import type { WorkerGrant } from "../src/lib/worker-sharing"

const owner = { id: "owner-worker", label: "Owner Mac", owner_user_id: "stable-owner", access: "owner", status: "online", created_at: 1, last_seen_at: 2, version: "0.2.0" }
const shared = { id: "shared-worker", label: "Shared Linux", owner_user_id: "remote-owner", access: "shared", status: "unknown", created_at: 1 }
async function fixture(page: Page, sharedOnly = false) {
  const calls: { path: string; method: string; body: string | null; session: string }[] = []
  let grants: WorkerGrant[] = []
  let fail: string | null = null
  let sync = false
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const session = request.headers()["x-fixture-session"]
    calls.push({ path, method: request.method(), body: request.postData(), session })
    if (fail && path.includes(fail)) return route.fulfill({ status: 503, json: { error: "Sharing service unavailable" } })
    if (path === "/api/me") return route.fulfill({ json: { user_id: session === "other-session" ? "other-user" : "stable-owner" } })
    if (path === "/api/workers") return route.fulfill({ json: session === "other-session" || sharedOnly ? [shared] : [owner, shared] })
    if (path === "/api/worker-release") return route.fulfill({ json: { version: "v0.2.0", release_url: "", platforms: [] } })
    if (path === "/api/workers/owner-worker/grants") return route.fulfill({ json: grants.map((grant) => ({ ...grant, synced_revision: sync ? grant.revision : grant.synced_revision })) })
    if (path.startsWith("/api/workers/owner-worker/grants/")) {
      const uid = decodeURIComponent(path.split("/").at(-1)!)
      if (request.method() === "PUT") {
        const value = { grantee_user_id: uid, grant_id: "grant-1", revoked_at: null, revision: 1, synced_revision: 0, created_at: 1, updated_at: 1 }
        grants = [value]
        return route.fulfill({ json: value })
      }
      grants = grants.map((grant) => ({ ...grant, revoked_at: 2, revision: 2, synced_revision: 1 }))
      sync = false
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ status: 403, json: { error: `Forbidden fixture request: ${path}` } })
  })
  return { calls, fail: (path: string | null) => { fail = path }, sync: () => { sync = true } }
}
async function openEnglish(page: Page) {
  await page.goto("/e2e/fixture.html#/workers")
  await page.getByRole("button", { name: "Language", exact: true }).click()
}

test("stable UID, exact-recipient validation, explicit grant consent, sync and revoke", async ({ page, context }) => {
  const state = await fixture(page)
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await openEnglish(page)
  const uid = page.getByRole("region", { name: "My user ID" })
  await expect(uid).toContainText("stable-owner")
  await expect(uid).not.toContainText("test-session")
  await uid.getByRole("button", { name: "Copy", exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("stable-owner")
  expect(state.calls.some((call) => call.path.includes("/grants"))).toBe(false)
  await page.getByRole("button", { name: "Share access", exact: true }).click()
  const panel = page.getByRole("region", { name: "Share access" })
  const grant = panel.getByRole("button", { name: "Grant access" })
  await expect(panel.getByText("No access granted yet.")).toBeVisible()
  await expect(grant).toBeDisabled()
  const input = panel.getByRole("textbox", { name: "Recipient user ID" })
  await input.fill("stable-owner")
  await expect(panel.getByText("You already own this device. Enter another user's ID.")).toBeVisible()
  await expect(grant).toBeDisabled()
  await input.fill(" recipient ")
  await expect(panel.getByText("Paste the exact user ID without spaces.")).toBeVisible()
  await input.fill("recipient")
  await expect(grant).toBeDisabled()
  await panel.getByRole("checkbox").check()
  await expect(panel).toContainText("without a sandbox")
  await grant.click()
  await expect(panel.getByText("Active", { exact: true })).toBeVisible()
  await expect(panel.getByText("Propagation pending")).toBeVisible()
  expect(state.calls.filter((call) => call.method === "PUT")).toEqual([{ path: "/api/workers/owner-worker/grants/recipient", method: "PUT", body: null, session: "test-session" }])
  state.sync()
  await expect(panel.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10000 })
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Queued and future calls will be blocked")
    expect(dialog.message()).toContain("already started may continue")
    await dialog.dismiss()
  })
  await panel.getByRole("button", { name: "Revoke access" }).click()
  expect(state.calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
  page.once("dialog", (dialog) => dialog.accept())
  await panel.getByRole("button", { name: "Revoke access" }).click()
  await expect(panel.getByText("Revoked", { exact: true })).toBeVisible()
  await expect(panel.getByText("Propagation pending")).toBeVisible()
})

test("shared-only discovery starts a Thread without owner controls or forbidden requests", async ({ page }) => {
  const state = await fixture(page, true)
  await openEnglish(page)
  await expect(page.getByText("Shared Linux", { exact: true })).toBeVisible()
  await expect(page.getByText("Owner:", { exact: false })).toContainText("remote-owner")
  await expect(page.getByText("Unknown · not queried live", { exact: true })).toBeVisible()
  for (const name of ["Share access", "Rename", "Remove", "Upgrade Worker", "Run connection check", "Generate manual configuration"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0)
  }
  await expect(page.getByText("Command execution verified; ready to use", { exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "Start using this device" }).click()
  await expect(page.getByTestId("draft")).toContainText("worker_id: shared-worker")
  expect(state.calls.every((call) => ["/api/me", "/api/workers", "/api/worker-release"].includes(call.path) && call.method === "GET")).toBe(true)
})

test("grant errors, list retry, account switching and mobile bilingual theme", async ({ page }) => {
  const state = await fixture(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await openEnglish(page)
  state.fail("/grants")
  await page.getByRole("button", { name: "Share access", exact: true }).click()
  const panel = page.getByRole("region", { name: "Share access" })
  await expect(panel.getByRole("alert").filter({ hasText: "Sharing service unavailable" })).toBeVisible()
  state.fail(null)
  await panel.getByRole("button", { name: "Retry" }).click()
  await expect(panel.getByText("No access granted yet.")).toBeVisible()
  await panel.getByRole("textbox").fill("recipient")
  await panel.getByRole("checkbox").check()
  state.fail("/grants/recipient")
  await panel.getByRole("button", { name: "Grant access" }).click()
  await expect(panel.getByRole("alert").filter({ hasText: "Sharing service unavailable" })).toBeVisible()
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await expect(page.getByRole("region", { name: "共享访问" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: "test-results/worker-sharing-mobile-dark.png", fullPage: true })
  await page.getByRole("button", { name: "Switch account" }).click()
  await expect(page.getByRole("region", { name: "我的用户 ID" })).toContainText("other-user")
  await expect(page.getByRole("region", { name: "共享访问" })).toHaveCount(0)
  await expect(page.getByText("Owner Mac", { exact: true })).toHaveCount(0)
  expect(state.calls.filter((call) => call.session === "other-session").every((call) => !call.path.includes("/grants"))).toBe(true)
})
