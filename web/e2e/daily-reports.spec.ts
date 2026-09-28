import { expect, test, type Page } from "@playwright/test"
import type { DailyReport, ReportSummary, SummaryState } from "../src/lib/daily-reports"

const empty: SummaryState = { latest: null, saved: null, stale: false }
function summary(id: number, threadId: string | null): ReportSummary {
  return {
    id, date: "2026-09-26", thread_id: threadId, source_fingerprint: "f".repeat(64), prompt_version: 1, model: "fixture-model", upstream_name: "Private upstream", language: "zh", status: "completed", error: null,
    content: { sections: (threadId ? ["goal", "progress", "decisions", "next_steps"] : ["completed", "decisions", "in_progress", "blocked"]).map((key, i) => ({ key, items: i === 0 ? [{ text: "已验证部署成功；下一项仍在进行中。", evidence: [42] }] : [] })) },
    source_manifest: { records: [{ id: 42, kind: "tool_output", created_at: 1790380801 }], background_input_id: 40, children: threadId ? [] : [{ thread_id: "thread-1", source_fingerprint: "a".repeat(64), summary_id: 1 }] },
    started_at: 1790380801, finished_at: 1790380831, requests: 2, input_tokens: 300, output_tokens: 50, missing_usage_requests: 0,
  }
}
const baseline: DailyReport = {
  date: "2026-09-26", timezone: "UTC", generated_at: 1790380831, active_thread_count: 1, activity_records: 20, input_records: 2, requests: 10, total_tokens: 1000,
  threads: [{ id: "thread-1", title: "上线验证", summary: "请完成上线", activity_count: 20, input_count: 2, request_count: 10, total_tokens: 1000, last_activity_at: 1790380801, daily_summary: empty }], summary: empty,
  generation: { job: null, running_job: null, generator: { model: "fixture-model", upstream_name: "Private upstream" } },
}
async function fixture(page: Page) {
  const state = { data: structuredClone(baseline), failLoad: false, failPost: false, posts: [] as unknown[], reads: 0 }
  await page.route("**/api/reports/**", async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    if (path === "/api/reports/summaries/1") return route.fulfill({ json: summary(1, "thread-1") })
    if (req.method() === "POST") {
      state.posts.push(req.postDataJSON())
      if (state.failPost) return route.fulfill({ status: 409, json: { error: "another report is generating" } })
      const job = { id: 5, date: "2026-09-26", thread_id: null, language: "zh", status: "running" as const, completed_threads: 0, total_threads: 1, phase: "threads", started_at: 1790380801, finished_at: null, error: null }
      state.data.generation = { ...state.data.generation, job, running_job: job }
      return route.fulfill({ status: 202, json: job })
    }
    state.reads++
    if (state.failLoad) return route.fulfill({ status: 500, json: { error: "daily report unavailable" } })
    if (req.headers()["x-fixture-session"] === "other" || req.url().includes("2026-09-25")) return route.fulfill({ json: { ...baseline, date: "2026-09-25", active_thread_count: 0, threads: [], generation: { ...baseline.generation, generator: null } } })
    return route.fulfill({ json: state.data })
  })
  return state
}
const url = "/e2e/daily-reports.html#/insights"

test("GET is read only, generating shows progress, refresh restores persisted summaries and source links", async ({ page }) => {
  const state = await fixture(page)
  await page.goto(url)
  await expect(page.getByText("尚未生成", { exact: true })).toHaveCount(2)
  expect(state.posts).toHaveLength(0)
  await page.getByRole("button", { name: "生成 / 更新日报", exact: true }).click()
  await expect(page.locator("div[role=status]")).toContainText("正在生成 Thread 日摘要")
  await expect(page.getByRole("button", { name: "生成 / 更新日报", exact: true })).toBeDisabled()
  await page.reload()
  await expect(page.locator("div[role=status]")).toContainText("0/1")
  expect(state.posts).toEqual([{ thread_id: null, language: "zh" }])
  const thread = summary(1, "thread-1"), day = summary(2, null)
  state.data.threads[0].daily_summary = { latest: thread, saved: thread, stale: false }
  state.data.summary = { latest: day, saved: day, stale: false }
  state.data.generation.running_job = null
  state.data.generation.job = { ...state.data.generation.job!, status: "completed", completed_threads: 1, finished_at: 1790380831 }
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await expect(page.getByText("已验证部署成功；下一项仍在进行中。", { exact: true })).toHaveCount(2)
  await expect(page.getByRole("link", { name: "#42", exact: true }).first()).toHaveAttribute("href", "#/history?id=42")
  const dayPanel = page.getByRole("region", { name: "今日概览", exact: true })
  await dayPanel.locator("summary").filter({ hasText: "版本与来源" }).click()
  await expect(dayPanel).toContainText("300 in / 50 out")
  await dayPanel.getByRole("button", { name: "查看摘要版本 #1" }).click()
  await expect(dayPanel.getByText("已验证部署成功；下一项仍在进行中。", { exact: true })).toHaveCount(2)
  await page.getByRole("link", { name: "#42", exact: true }).first().click()
  await expect(page).toHaveURL(/#\/history\?id=42$/)
  expect(state.posts).toHaveLength(1)
})

test("stale/failed states retain previous evidence, individual retry is explicit, date/account changes never leak cached content", async ({ page }) => {
  const state = await fixture(page)
  const saved = summary(1, "thread-1")
  state.data.threads[0].daily_summary = { saved, latest: { ...saved, id: 3, status: "failed", error: "invalid evidence ID", content: null }, stale: true }
  state.data.generation.job = { id: 1, date: "2026-09-26", thread_id: "thread-1", language: "zh", status: "failed", completed_threads: 1, total_threads: 1, phase: "threads", started_at: 1790380801, finished_at: 1790380831, error: "one Thread failed" }
  await page.goto(url)
  await expect(page.getByText("需要更新", { exact: true })).toBeVisible()
  await expect(page.getByText("保留的上一次成功摘要")).toBeVisible()
  await expect(page.getByText("invalid evidence ID")).toBeVisible()
  state.failPost = true
  await page.getByRole("button", { name: "生成 / 更新日摘要", exact: true }).click()
  await expect(page.getByText("another report is generating")).toBeVisible()
  expect(state.posts).toEqual([{ thread_id: "thread-1", language: "zh" }])
  await page.getByRole("button", { name: "Other user", exact: true }).click()
  await expect(page.getByText("这一天没有活跃 Thread。")).toBeVisible()
  await expect(page.getByText("已验证部署成功；下一项仍在进行中。")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "生成 / 更新日报", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Other day", exact: true }).click()
  await expect(page.getByText("another report is generating")).toHaveCount(0)
})

test("network recovery and bilingual mobile/dark layouts preserve readable evidence", async ({ page }) => {
  const state = await fixture(page)
  state.failLoad = true
  await page.goto(url)
  await expect(page.getByText("daily report unavailable")).toBeVisible()
  state.failLoad = false
  const saved = summary(1, "thread-1")
  saved.content!.sections[0].items[0].text = "交付物" + "a".repeat(300)
  state.data.threads[0].daily_summary = { saved, latest: saved, stale: false }
  await page.getByRole("button", { name: "重试", exact: true }).click()
  await expect(page.getByRole("link", { name: "#42", exact: true })).toBeVisible()
  for (const language of ["zh", "en"]) {
    if (language === "en") await page.getByRole("button", { name: "Language", exact: true }).click()
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle("dark", value), dark)
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      }
    }
  }
  await page.getByRole("link", { name: "#42", exact: true }).focus()
  await expect(page.getByRole("link", { name: "#42", exact: true })).toBeFocused()
  await page.screenshot({ path: "test-results/daily-reports-mobile.png", fullPage: true })
  expect(state.posts).toHaveLength(0)
})
