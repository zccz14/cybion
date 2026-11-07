import { expect, test, type Page } from "@playwright/test"
import { stubWorkspace } from "./workspace-fixture"
import { emptyThreadUsage } from "../src/lib/thread-usage"

const thread = (id = "created-thread") => ({
  id, title: id === "created-thread" ? "Fixture conversation" : "Other conversation",
  status: "idle", display_status: "ready", running_summary: null,
  model: "deepseek-flash", upstream_id: "normai-upstream", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: null, minimal_mode: null, max_loaded_manuals: null,
  image_generation_model: null, audio_transcription_model: null,
  usage: emptyThreadUsage, context_tokens: 0, archived_at: null,
  created_at: 1700000000, updated_at: 1700000000, created_by: "web", external_ref: null,
})
const input = (id: number, text = `Turn ${id}`) => ({ id, thread_id: "created-thread", kind: "input", payload: { role: "user", content: text }, created_at: 1700000000 + id })
const reply = (id: number, text: string) => ({ id, thread_id: "created-thread", kind: "response_output", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] }, created_at: 1700000000 + id })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }
async function setup(page: Page) {
  const fixture = await stubWorkspace(page, { language: "zh", activeTotal: 1, manuals: [{ id: "manual-1", name: "Historical Manual" }] })
  const current = thread()
  const records = [input(30), reply(31, "The current reply")]
  await page.route("**/api/threads/created-thread", (route) => route.fulfill({ json: current }))
  await page.route("**/api/threads/created-thread/history/window*", (route) => route.fulfill({ json: { records, has_older: false } }))
  await page.route("**/api/threads/*/history?after=*", (route) => route.fulfill({ json: [] }))
  return { fixture, current, records }
}
const open = (page: Page) => page.goto("/#/threads/created-thread")
const composer = (page: Page) => page.getByPlaceholder("继续描述你的需求…")

test("catalog failures and a slow transcript never hide the header or composer", async ({ page }) => {
  const { fixture } = await setup(page)
  const history = deferred()
  await page.route("**/api/integrations/upstreams/models*", (route) => route.fulfill({ status: 503, json: { error: "catalog unavailable" } }))
  await page.route("**/api/threads/created-thread/history/window*", async (route) => { await history.promise; await route.fulfill({ json: { records: [input(30)], has_older: false } }) })
  await open(page)
  await expect(page.getByRole("heading", { name: "Fixture conversation" })).toBeVisible()
  await expect(composer(page)).toBeEditable()
  await expect(page.locator('[data-slot="message-scroller-content"] [data-slot="skeleton"]')).toHaveCount(2)
  await expect(page.getByText("这个线程还没有消息。")).toHaveCount(0)
  history.resolve()
  await expect(page.getByText("Turn 30", { exact: true })).toBeVisible()
  expect(fixture.unexpected).toEqual([])
})

test("three history pages prepend oldest-first, stop at the beginning, and survive switching threads", async ({ page }) => {
  const { fixture } = await setup(page)
  const cursors: string[] = []
  await page.route("**/api/threads/created-thread/history/window*", (route) => {
    const before = new URL(route.request().url()).searchParams.get("before")
    cursors.push(before ?? "tail")
    const id = before === null ? 30 : Number(before) - 10
    return route.fulfill({ json: { records: [input(id)], has_older: id > 10 } })
  })
  await page.route("**/api/threads/other-thread", (route) => route.fulfill({ json: thread("other-thread") }))
  await page.route("**/api/threads/other-thread/**", (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({ json: path.endsWith("/window") ? { records: [], has_older: false } : path.endsWith("/loaded") ? { head: null, tail: null, loaded: [] } : path.endsWith("/grants") ? [] : null })
  })
  await open(page)
  const earlier = page.getByRole("button", { name: "加载更早消息", exact: true })
  await earlier.click()
  await expect(page.getByText("Turn 20", { exact: true })).toBeAttached()
  await earlier.click()
  await expect(earlier).toHaveCount(0)
  // The actual renderer's DOM order, not a helper-only test.
  const texts = await page.locator('[data-slot="message-scroller-content"]').innerText()
  expect(texts.indexOf("Turn 10")).toBeLessThan(texts.indexOf("Turn 20"))
  expect(texts.indexOf("Turn 20")).toBeLessThan(texts.indexOf("Turn 30"))
  await composer(page).fill("draft for original thread")
  await page.evaluate(() => { location.hash = "/threads/other-thread" })
  await expect(page.getByRole("heading", { name: "Other conversation" })).toBeVisible()
  await expect(composer(page)).toHaveValue("")
  await page.evaluate(() => { location.hash = "/threads/created-thread" })
  await expect(page.getByText("Turn 10", { exact: true })).toBeAttached()
  await expect(composer(page)).toHaveValue("draft for original thread")
  await expect(earlier).toHaveCount(0)
  expect(cursors).toEqual(["tail", "30", "20"])
  expect(fixture.unexpected).toEqual([])
})

test("failed send keeps the draft and retry alert through polling, then sends trimmed input", async ({ page }) => {
  const { fixture } = await setup(page)
  let fail = true
  const bodies: unknown[] = []
  await page.route("**/api/threads/created-thread/inputs", (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "send temporarily unavailable" } : { thread_id: "created-thread", record_idx: 32, status: "accepted" } })
  })
  await open(page)
  await composer(page).fill("  retain this draft  ")
  await page.getByRole("button", { name: "发送", exact: true }).click()
  await expect(page.getByText("send temporarily unavailable")).toBeVisible()
  await expect(composer(page)).toHaveValue("  retain this draft  ")
  const reads = fixture.requests.filter((path) => path === "/api/notes").length
  await expect.poll(() => fixture.requests.filter((path) => path === "/api/notes").length).toBeGreaterThan(reads)
  await expect(page.getByText("send temporarily unavailable")).toBeVisible()
  fail = false
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(composer(page)).toHaveValue("")
  await expect(page.getByText("send temporarily unavailable")).toHaveCount(0)
  expect(bodies).toEqual(Array(2).fill({ input: "retain this draft", images: [], audios: [] }))
  expect(fixture.unexpected).toEqual([])
})

test("title generation has pending feedback and refreshes the saved title and rename draft", async ({ page }) => {
  const { current, fixture } = await setup(page)
  const pending = deferred()
  await page.route("**/api/threads/created-thread/title", async (route) => {
    await pending.promise; current.title = "Generated title"; await route.fulfill({ json: current })
  })
  await open(page)
  const generate = page.getByRole("button", { name: "引用全部重放内容生成标题", exact: true })
  await expect(generate).toBeEnabled()
  await generate.click()
  await expect(generate).toBeDisabled()
  await expect(generate.locator('[data-slot="spinner"]')).toHaveCount(1)
  pending.resolve()
  await expect(page.getByRole("heading", { name: "Generated title" })).toBeVisible()
  await page.getByRole("button", { name: "重命名", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "对话名称" })).toHaveValue("Generated title")
  expect(fixture.unexpected).toEqual([])
})

test("historical manual metadata resolves without loaded bindings and links stay in HashRouter", async ({ page }) => {
  const { records, fixture } = await setup(page)
  records.splice(0, records.length,
    { ...input(30), kind: "activity", payload: { type: "manual_unloaded", manual_id: "manual-1" } } as never,
    { ...input(31), kind: "response_output", payload: { type: "function_call", name: "load_manual", call_id: "c1", arguments: JSON.stringify({ manual_id: "manual-1" }) } } as never,
  )
  await open(page)
  const collapsed = page.locator('summary').filter({ hasText: /过程|Process/ })
  await collapsed.first().click()
  await expect(page.getByRole("link", { name: "Historical Manual" })).toHaveCount(2)
  for (const link of await page.getByRole("link", { name: "Historical Manual" }).all()) await expect(link).toHaveAttribute("href", "#/manuals?manual=manual-1")
  await page.getByRole("link", { name: "Historical Manual" }).first().click()
  await expect(page).toHaveURL(/#\/manuals\?manual=manual-1$/)
  expect(fixture.unexpected).toEqual([])
})

for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`original conversation layout and footer ordering at ${size.width}px`, async ({ page }, info) => {
    const { current, fixture } = await setup(page)
    current.status = "running"; current.display_status = "running"
    await page.route("**/api/notes", (route) => route.fulfill({ json: { open: [{ id: "n1", thread_id: current.id, thread_title: current.title, text: "Finish the parity check", created_at: 1700000000, done_at: null }], done: [] } }))
    await page.setViewportSize(size)
    await open(page)
    await expect(page.getByText("The current reply", { exact: true })).toBeVisible()
    await expect(composer(page)).toBeVisible()
    await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible()
    const content = page.locator('[data-slot="message-scroller-content"]')
    const text = await content.innerText()
    expect(text.indexOf("运行中")).toBeLessThan(text.indexOf("Finish the parity check"))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ animations: "disabled", path: info.outputPath(`conversation-${size.width}.png`), fullPage: true })
    expect(fixture.unexpected).toEqual([])
  })
}

test("initial streaming preview is independent of catalogs and follows the original running cadence", async ({ page }) => {
  const { current, fixture } = await setup(page)
  current.status = "running"; current.display_status = "running"
  const catalog = deferred()
  let reads = 0
  await page.route("**/api/integrations/upstreams/models*", async (route) => { await catalog.promise; await route.fulfill({ json: { upstreams: [] } }) })
  await page.route("**/api/threads/created-thread/response", (route) => {
    reads++
    return route.fulfill({ json: { thread_id: current.id, started_at: 1700000000, response: { completed: false, output: [{ record_id: null, done: false, item: { id: "preview", type: "message", role: "assistant", content: [{ type: "output_text", text: "Live preview before catalog" }] } }] } } })
  })
  await open(page)
  await expect(page.getByText("Live preview before catalog", { exact: true })).toBeVisible()
  const initial = reads
  await expect.poll(() => reads, { timeout: 1800, intervals: [100] }).toBeGreaterThanOrEqual(initial + 2)
  catalog.resolve()
  expect(fixture.unexpected).toEqual([])
})

test("recording keeps text editable, disables text send, and sends voice plus draft together", async ({ page }) => {
  const { fixture } = await setup(page)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
    class Recorder {
      state = "inactive"; mimeType = "audio/webm"
      ondataavailable?: (event: { data: Blob }) => void
      onstop?: () => void
      start() { this.state = "recording" }
      stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["fixture audio"], { type: this.mimeType }) }); this.onstop?.() }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: Recorder })
  })
  const bodies: { input: string; images: string[]; audios: string[] }[] = []
  await page.route("**/api/threads/created-thread/inputs", (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { thread_id: "created-thread", record_idx: 32, status: "accepted" } })
  })
  await open(page)
  await composer(page).fill("voice context")
  await page.getByRole("button", { name: "录制语音", exact: true }).click()
  await expect(page.getByRole("button", { name: "发送语音", exact: true })).toBeVisible()
  await expect(composer(page)).toBeEditable()
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "发送语音", exact: true }).click()
  await expect(composer(page)).toHaveValue("")
  expect(bodies).toHaveLength(1)
  expect(bodies[0].input).toBe("voice context")
  expect(bodies[0].audios[0]).toMatch(/^data:audio\/webm;base64,/)
  expect(fixture.unexpected).toEqual([])
})

test("control pending feedback belongs to its action and clears only after cache refresh", async ({ page }) => {
  const { fixture } = await setup(page)
  const compact = deferred()
  await page.route("**/api/threads/created-thread/compact", async (route) => { await compact.promise; await route.fulfill({ json: {} }) })
  await open(page)
  const button = page.getByTitle("将重放上下文压缩为检查点，保留原始记录", { exact: true })
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toBeDisabled()
  await expect(button.locator('[data-slot="spinner"]')).toHaveCount(1)
  await expect(composer(page)).toBeDisabled()
  await expect(page.getByRole("button", { name: "继续", exact: true }).locator('[data-slot="spinner"]')).toHaveCount(0)
  compact.resolve()
  await expect(composer(page)).toBeEditable()
  expect(fixture.unexpected).toEqual([])
})

test("a failed older page has its own retry next to the load control", async ({ page }) => {
  const { fixture } = await setup(page)
  let fail = true
  await page.route("**/api/threads/created-thread/history/window*", (route) => {
    const older = new URL(route.request().url()).searchParams.has("before")
    return route.fulfill({ status: older && fail ? 503 : 200, json: older && fail ? { error: "older page unavailable" } : { records: [input(older ? 20 : 30)], has_older: !older } })
  })
  await open(page)
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click()
  await expect(page.getByText("older page unavailable")).toBeVisible()
  await expect(composer(page)).toBeEditable()
  fail = false
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByText("Turn 20", { exact: true })).toBeAttached()
  await expect(page.getByText("older page unavailable")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "加载更早消息", exact: true })).toHaveCount(0)
  expect(fixture.unexpected).toEqual([])
})
