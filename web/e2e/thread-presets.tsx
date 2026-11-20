import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CybionThreadProvider } from "@zccz14/cybion-components"
import { type ModelCatalog } from "@zccz14/cybion-components/internal"
import { ThreadPresets } from "../src/components/thread-presets"
import "../src/styles.css"

const catalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash", "gpt-6-astra"], error: null },
]

const manualChoices = [
  { manual_id: "11111111-1111-4111-8111-111111111111", name: "必读手册" },
  { manual_id: "22222222-2222-4222-8222-222222222222", name: "量化交易指南" },
  { manual_id: "33333333-3333-4333-8333-333333333333", name: "深度研究指南" },
]

const defaults = {
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "",
  audio_transcription_model: null, max_loaded_manuals: 12, budget_usd_nanos: 0,
  initial_manual_ids: [manualChoices[0].manual_id],
}

// 三个真实形态的预设：一个研究、一个工程、一个探索。
const presets = [
  {
    name: "researcher",
    settings: { ...defaults, model: "gpt-6-astra", reasoning_effort: "max", initial_manual_ids: [manualChoices[2].manual_id, manualChoices[1].manual_id, manualChoices[0].manual_id] },
    thread_count: 12,
  },
  {
    name: "engineer",
    settings: { ...defaults, model: "deepseek-flash", reasoning_effort: "max", budget_usd_nanos: 2_000_000_000, initial_manual_ids: [manualChoices[0].manual_id] },
    thread_count: 41,
  },
  {
    name: "explorer",
    settings: { ...defaults, model: "deepseek-flash", reasoning_effort: "max", max_loaded_manuals: 4, initial_manual_ids: [] },
    thread_count: 0,
  },
]

/// 走查页替 API 作答：列表、默认值、手册目录与模型目录都从这里来。
const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  const path = url.pathname
  const method = (init?.method ?? "GET").toUpperCase()
  if (path.startsWith("/api/thread-presets")) {
    if (method === "DELETE") return new Response(JSON.stringify({ deleted: true }), { headers: { "Content-Type": "application/json" } })
    if (method === "PUT") {
      const name = decodeURIComponent(path.slice("/api/thread-presets/".length))
      const settings = JSON.parse(String(init?.body ?? "{}"))
      return new Response(JSON.stringify({ name, settings, thread_count: 1 }), { headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify(presets), { headers: { "Content-Type": "application/json" } })
  }
  const body = path === "/api/thread-defaults" ? defaults
    : path === "/api/manual-summaries" ? { manuals: manualChoices }
    : url.searchParams.get("kind") === "image" ? { upstreams: [] }
    : url.searchParams.get("kind") === "sst" ? { upstreams: [] }
    : { upstreams: catalogs }
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById("root")!).render(<StrictMode>
  <QueryClientProvider client={queryClient}>
    <HashRouter>
      <CybionThreadProvider baseUrl="https://cybion.test" getToken={() => "token"} fetch={fetch} identity="e2e" language="zh" queryClient={queryClient}>
        <main className="mx-auto flex max-w-3xl flex-col gap-6 p-5">
          <ThreadPresets language="zh" sessionId="e2e" />
        </main>
      </CybionThreadProvider>
    </HashRouter>
  </QueryClientProvider>
</StrictMode>)
