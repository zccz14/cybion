import { expect, test } from "@playwright/test"
import { composerDraftKey } from "../src/lib/composer-drafts"

const pageUrl = "/e2e/composer-drafts.html#/threads/a"

test("every thread and the new-thread composer restore independent drafts after navigation and refresh", async ({ page }) => {
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await input.fill("  线程 A\n第二行  ")
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("")
  await input.fill("Thread B draft")
  await page.getByRole("link", { name: "Create", exact: true }).click()
  await expect(input).toHaveValue("")
  await input.fill("New thread draft")
  await page.getByRole("link", { name: "Create alias", exact: true }).click()
  await expect(input).toHaveValue("New thread draft")
  await page.reload()
  await expect(input).toHaveValue("New thread draft")
  await page.getByRole("link", { name: "Thread A", exact: true }).click()
  await expect(input).toHaveValue("  线程 A\n第二行  ")
  await page.reload()
  await expect(input).toHaveValue("  线程 A\n第二行  ")
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("Thread B draft")
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await expect(input).toHaveValue("")
  await input.fill("Owner B, Thread B")
  await page.getByRole("button", { name: "Account", exact: true }).click()
  await expect(input).toHaveValue("Thread B draft")
})

test("failed sends keep raw text; accepted sends remove only their own draft", async ({ page }) => {
  let fail = true
  const submitted: string[] = []
  await page.route("**/draft-test/send", async (route) => {
    submitted.push(route.request().postDataJSON().input)
    await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "failed" } : { status: "accepted", thread_id: "created" } })
  })
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await input.fill("  send me\nplease  ")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page.getByRole("alert")).toHaveText("Send failed")
  await expect(input).toHaveValue("  send me\nplease  ")
  await page.reload()
  await expect(input).toHaveValue("  send me\nplease  ")
  fail = false
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toHaveValue("")
  await page.reload()
  await expect(input).toHaveValue("")
  expect(submitted).toEqual(["send me\nplease", "send me\nplease"])
})

test("late success cannot clear a different thread or a newer draft of the source thread", async ({ page }) => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  await page.route("**/draft-test/send", async (route) => { await gate; await route.fulfill({ json: { status: "accepted", thread_id: "created" } }) })
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await input.fill("Sending A")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toBeDisabled()
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await input.fill("Keep B")
  await page.getByRole("link", { name: "Thread A", exact: true }).click()
  await expect(input).toHaveValue("Sending A")
  await input.fill("New A draft")
  const response = page.waitForResponse("**/draft-test/send")
  finish()
  await response
  await expect(input).toHaveValue("New A draft")
  await page.reload()
  await expect(input).toHaveValue("New A draft")
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("Keep B")
})

test("Worker prefills seed only empty drafts and consumed navigation state cannot resurrect sent text", async ({ page }) => {
  await page.route("**/draft-test/send", (route) => route.fulfill({ json: { status: "accepted", thread_id: "created" } }))
  await page.goto(pageUrl)
  await page.getByRole("link", { name: "Worker prefill", exact: true }).click()
  const input = page.getByRole("textbox")
  await expect(input).toHaveValue("First device instruction")
  await page.reload()
  await expect(input).toHaveValue("First device instruction")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(page).toHaveURL(/#\/threads\/created$/)
  await page.goBack()
  await expect(input).toHaveValue("")
  await page.reload()
  await expect(input).toHaveValue("")
  await input.fill("Keep my existing new-thread draft")
  await page.getByRole("link", { name: "Thread A", exact: true }).click()
  await page.getByRole("link", { name: "Worker prefill", exact: true }).click()
  await expect(input).toHaveValue("Keep my existing new-thread draft")
  await page.getByRole("button", { name: "Delete thread", exact: true }).click()
  await page.reload()
  await expect(input).toHaveValue("")
})

test("storage failures preserve editable text and surface a persistence warning", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError") }
    Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError") }
  })
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await expect(page.getByRole("status")).toContainText("无法在此浏览器保存草稿")
  await input.fill("Still editable\n不会吞掉输入")
  await expect(input).toHaveValue("Still editable\n不会吞掉输入")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
})

test("same-browser tabs sync only matching draft keys", async ({ page, context }) => {
  await page.goto(pageUrl)
  const other = await context.newPage()
  await other.goto(pageUrl)
  await page.getByRole("textbox").fill("Shared A")
  await expect(other.getByRole("textbox")).toHaveValue("Shared A")
  await other.getByRole("link", { name: "Thread B", exact: true }).click()
  await page.getByRole("textbox").fill("A changed")
  await expect(other.getByRole("textbox")).toHaveValue("")
  await other.close()
})


test("late acceptance clears an unchanged source composer reopened during the request", async ({ page }) => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  await page.route("**/draft-test/send", async (route) => { await gate; await route.fulfill({ json: { status: "accepted", thread_id: "created" } }) })
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await input.fill("Pending A")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toBeDisabled()
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("")
  await input.fill("Keep B")
  await page.getByRole("link", { name: "Thread A", exact: true }).click()
  await expect(input).toHaveValue("Pending A")
  finish()
  await expect(input).toHaveValue("")
  await page.reload()
  await expect(input).toHaveValue("")
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("Keep B")
})


test("late new-thread acceptance does not redirect or clear a different active composer", async ({ page }) => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  await page.route("**/draft-test/send", async (route) => { await gate; await route.fulfill({ json: { status: "accepted", thread_id: "created" } }) })
  await page.goto("/e2e/composer-drafts.html#/threads/new")
  const input = page.getByRole("textbox")
  await input.fill("Creating a thread")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toBeDisabled()
  await page.getByRole("link", { name: "Thread B", exact: true }).click()
  await expect(input).toHaveValue("")
  await input.fill("Keep editing B")
  finish()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), composerDraftKey("owner-a", null))).toBeNull()
  await expect(page).toHaveURL(/#\/threads\/b$/)
  await expect(input).toHaveValue("Keep editing B")
  await page.getByRole("link", { name: "Create", exact: true }).click()
  await expect(input).toHaveValue("")
})


test("accepting an in-memory draft does not falsely clear an earlier storage failure", async ({ page }) => {
  await page.route("**/draft-test/send", (route) => route.fulfill({ json: { status: "accepted", thread_id: "created" } }))
  await page.goto(pageUrl)
  const input = page.getByRole("textbox")
  await input.fill("Last persisted draft")
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError") } })
  await input.fill("New in-memory text")
  await expect(page.getByRole("status")).toContainText("无法在此浏览器保存草稿")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await expect(input).toHaveValue("")
  await expect(page.getByRole("status")).toContainText("无法在此浏览器保存草稿")
})
