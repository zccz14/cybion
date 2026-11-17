import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import type { Thread, ThreadDefaults, UpstreamModels } from "../src/api"
import { ThreadSettingsButton } from "../src/components/thread-settings-button"
import { CybionThreadProvider } from "../src/provider"

afterEach(cleanup)

beforeAll(() => {
  class Observer {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return [] }
  }
  window.IntersectionObserver = Observer as unknown as typeof window.IntersectionObserver
  window.ResizeObserver = Observer as unknown as typeof window.ResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const thread: Thread = {
  id: "thread-a", title: "Fixture", status: "idle", display_status: "ready", running_summary: null,
  created_by: "web", external_ref: null, model: "deepseek-flash", upstream_id: "up-deepseek",
  reasoning_effort: "medium", service_tier_fast: false, context_budget_tokens: null, minimal_mode: null,
  image_generation_model: null, audio_transcription_model: null, max_loaded_manuals: null,
  budget_usd_nanos: null, initial_manual_ids: null, archived_at: null, context_tokens: null,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_hit_rate: null, cost_usd_nanos: 0, cost_settled_requests: 0 },
  created_at: 1, updated_at: 1,
}

const defaults: ThreadDefaults = {
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "", audio_transcription_model: null,
  max_loaded_manuals: 12, budget_usd_nanos: 0, initial_manual_ids: [],
}

const catalogs: UpstreamModels = { upstreams: [{ id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash"], error: null }] }

/** One fixture per test: records what the button asked for and what it wrote. */
function harness(respond: (path: string) => unknown, open = false) {
  const reads: string[] = []
  const writes: { path: string; body: unknown; method: string }[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search
    if ((init?.method ?? "GET") === "GET") reads.push(path)
    else writes.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, method: init!.method! })
    return new Response(JSON.stringify(respond(path)), { headers: { "Content-Type": "application/json" } })
  }
  const view = createElement(CybionThreadProvider, {
    baseUrl: "https://cybion.test", identity: "user", sessionId: "session", getToken: () => "token",
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), fetch, language: "zh",
    children: createElement(ThreadSettingsButton, { threadId: "thread-a", defaultOpen: open }),
  })
  return { reads, writes, render: () => render(view) }
}

describe("the thread settings button", () => {
  it("fetches the thread, the defaults and every catalog it picks from, then saves what it edits", async () => {
    const fixture = harness((path) => {
      if (path.startsWith("/api/threads/thread-a")) return thread
      if (path === "/api/thread-defaults") return defaults
      if (path.startsWith("/api/integrations/upstreams/models")) return catalogs
      if (path === "/api/manual-summaries") return { manuals: [] }
      return {}
    }, true)
    fixture.render()
    // Opened by threadId alone: the trigger names the model and the effort.
    const trigger = await screen.findByRole("button", { name: "线程设置: deepseek-flash (medium)" })
    await waitFor(() => expect(fixture.reads).toContain("/api/threads/thread-a"))
    expect(fixture.reads).toContain("/api/thread-defaults")
    expect(fixture.reads).toContain("/api/integrations/upstreams/models")
    expect(fixture.reads).toContain("/api/integrations/upstreams/models?kind=image")
    expect(fixture.reads).toContain("/api/integrations/upstreams/models?kind=sst")
    expect(fixture.reads).toContain("/api/manual-summaries")
    expect(trigger).toBeTruthy()
  })

  it("prefers the Thread the host already rendered over the one it fetches", async () => {
    const fixture = harness((path) => path === "/api/thread-defaults" ? defaults : catalogs)
    render(createElement(CybionThreadProvider, {
      baseUrl: "https://cybion.test", identity: "user", sessionId: "session", getToken: () => "token",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), fetch: async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
      language: "en",
      children: createElement(ThreadSettingsButton, { threadId: "thread-a", value: { ...thread, model: "gpt-6-astra", reasoning_effort: "high" } }),
    }))
    // No flash of an empty trigger while the detail read is in flight.
    expect(screen.getByRole("button", { name: "Thread settings: gpt-6-astra (high)" })).toBeTruthy()
    void fixture
  })
})

describe("the thread settings button writes through the API", () => {
  it("sends the one setting it edited as a PATCH of that Thread", async () => {
    const fixture = harness((path) => {
      if (path.startsWith("/api/threads/thread-a")) return thread
      if (path === "/api/thread-defaults") return defaults
      if (path.startsWith("/api/integrations/upstreams/models")) return catalogs
      if (path === "/api/manual-summaries") return { manuals: [] }
      return {}
    }, true)
    fixture.render()
    await screen.findByRole("button", { name: /线程设置/ })
    // The spend limit is the field that proved the draft handling, and it writes
    // nanodollars straight from what was typed.
    const input = await screen.findByLabelText("花费上限（USD）") as HTMLInputElement
    fireEvent.change(input, { target: { value: "0.05" } })
    await waitFor(() => expect(fixture.writes).toHaveLength(1))
    expect(fixture.writes[0].method).toBe("PATCH")
    expect(fixture.writes[0].path).toBe("/api/threads/thread-a")
    expect(fixture.writes[0].body).toEqual({ budget_usd_nanos: 50_000_000 })
  })
})
