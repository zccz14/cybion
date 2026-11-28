import { createElement, useState } from "react"
import { QueryClient } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import type { ThreadDefaults, UpstreamModels } from "../src/api"
import { ThreadSettingsFields } from "../src/components/thread-settings-fields"
import type { ThreadSettings } from "../src/lib/thread-settings"
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

const defaults: ThreadDefaults = {
  search_source: null,
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "gpt-image-2",
  audio_transcription_model: "whisper-1", max_loaded_manuals: 12, initial_manual_ids: ["manual-a"],
  budget_usd_nanos: 10_000_000_000,
}

const catalogs: UpstreamModels = { upstreams: [{ id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash"], error: null }] }

/// A Thread that follows every account default: what the composer starts from.
const following: ThreadSettings = {
  search_source: null,
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: null, minimal_mode: null, image_generation_model: null,
  audio_transcription_model: null, max_loaded_manuals: null, initial_manual_ids: null, budget_usd_nanos: null,
}

/// The account's own settings: every field concrete, nothing to follow.
const concrete: ThreadSettings = {
  ...following, context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "",
  audio_transcription_model: null, max_loaded_manuals: 12, initial_manual_ids: ["manual-a"], budget_usd_nanos: 0,
}

/** Renders the control with its own state, and reports the value it holds. */
function harness(initial: ThreadSettings, mode: "override" | "defaults") {
  const reads: string[] = []
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    reads.push(url.pathname + url.search)
    const body = url.pathname === "/api/thread-defaults" ? defaults
      : url.pathname === "/api/manual-summaries" ? { manuals: [{ manual_id: "manual-a", name: "必读手册" }, { manual_id: "manual-b", name: "Codex 指南" }] }
        : catalogs
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  }
  function Controlled() {
    const [value, setValue] = useState(initial)
    return createElement("div", null,
      createElement(ThreadSettingsFields, { value, onChange: setValue, mode, language: "zh" }),
      createElement("output", { "data-testid": "value" }, JSON.stringify(value)),
    )
  }
  return {
    reads,
    current: () => JSON.parse(screen.getByTestId("value").textContent!) as ThreadSettings,
    render: () => render(createElement(CybionThreadProvider, {
      baseUrl: "https://cybion.test", identity: "user", sessionId: "session", getToken: () => "token",
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), fetch, language: "zh",
      children: createElement(Controlled),
    })),
  }
}

describe("the settings form control", () => {
  it("reads the account defaults and every catalog from the provider, needing only a value and an onChange", async () => {
    const fixture = harness(following, "override")
    fixture.render()
    await waitFor(() => expect(fixture.reads).toContain("/api/thread-defaults"))
    expect(fixture.reads).toContain("/api/integrations/upstreams/models")
    expect(fixture.reads).toContain("/api/integrations/upstreams/models?kind=image")
    expect(fixture.reads).toContain("/api/integrations/upstreams/models?kind=sst")
    await waitFor(() => expect(fixture.reads).toContain("/api/manual-summaries"))
    expect(await screen.findByLabelText("花费上限（USD）")).toBeTruthy()
  })

  it("hands back the whole next value, leaving every setting it did not touch alone", async () => {
    const fixture = harness(following, "override")
    fixture.render()
    const limit = await screen.findByLabelText("花费上限（USD）") as HTMLInputElement
    fireEvent.change(limit, { target: { value: "0.05" } })
    await waitFor(() => expect(fixture.current().budget_usd_nanos).toBe(50_000_000))
    // One field moved; the rest of the value is exactly as it was seeded, which is
    // what lets one control serve all three surfaces.
    expect(fixture.current().model).toBe("deepseek-flash")
    expect(fixture.current().context_budget_tokens).toBeNull()
    expect(fixture.current().initial_manual_ids).toBeNull()
  })

  it("shows the account default as a placeholder while a setting follows it", async () => {
    const fixture = harness(following, "override")
    fixture.render()
    // Following the default: the box is empty and the default is the placeholder.
    const cap = await screen.findByLabelText("已加载手册上限") as HTMLInputElement
    await waitFor(() => expect(cap.placeholder).toBe("12"))
    expect(cap.value).toBe("")
    const budget = await screen.findByLabelText("上下文窗口限制") as HTMLInputElement
    expect(budget.placeholder).toBe("200000")
    expect(budget.value).toBe("")
  })

  it("offers no \"follow default\" when it edits the defaults themselves", async () => {
    const fixture = harness(concrete, "defaults")
    fixture.render()
    await waitFor(() => expect(fixture.reads).toContain("/api/thread-defaults"))
    // The defaults form renders the values it holds, with no inherit option: the
    // placeholder is never another setting, and nothing offers to follow one.
    const limit = await screen.findByLabelText("花费上限（USD）") as HTMLInputElement
    expect(limit.value).toBe("0")
    const cap = screen.getByLabelText("已加载手册上限") as HTMLInputElement
    expect(cap.value).toBe("12")
    expect(screen.getByRole("combobox", { name: "极简模式" }).textContent).toBe("关闭")
    expect(screen.getByRole("combobox", { name: "图像生成" }).textContent).toBe("关闭")
    expect(screen.queryByRole("button", { name: "跟随默认" })).toBeNull()
  })
})
