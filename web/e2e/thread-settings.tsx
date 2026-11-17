import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CybionThreadProvider, ThreadSettingsPopover, type ModelCatalog, type ThreadSettings } from "@zccz14/cybion-components"
import { Button } from "../src/components/ui/button"
import "../src/styles.css"

const catalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash", "gpt-6-astra"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["meta-llama/Llama-3.1-8B-Instruct"], error: "Could not load models" },
]

// Image and speech-to-text catalogs come from the same endpoint, narrowed by
// `?kind=`; the control asks for all three itself.
const audioCatalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["whisper-1"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["gpt-4o-transcribe"], error: null },
]

const imageCatalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["gpt-image-2"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["gpt-image-2-mini"], error: null },
]

// The Manuals the picker may name, exactly as `GET /api/manual-summaries`
// answers them: ids and names, no bodies.
const manualChoices = [
  { manual_id: "11111111-1111-4111-8111-111111111111", name: "必读手册" },
  { manual_id: "22222222-2222-4222-8222-222222222222", name: "Codex 指南" },
  { manual_id: "33333333-3333-4333-8333-333333333333", name: "前端开发指南" },
]

// The account defaults: what every Thread follows where its own value is null.
const defaults = {
  model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "gpt-image-2",
  audio_transcription_model: "whisper-1", max_loaded_manuals: 12, budget_usd_nanos: 10_000_000_000,
  initial_manual_ids: [manualChoices[0].manual_id],
}

/// The control reads the defaults and the three catalogs through the provider, so
/// the walkthrough stands in for the API rather than passing them in.
const fetch: typeof globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  const path = url.pathname + url.search
  const body = path === "/api/thread-defaults" ? defaults
    : path === "/api/manual-summaries" ? { manuals: manualChoices }
    : path.endsWith("kind=image") ? { upstreams: imageCatalogs }
    : path.endsWith("kind=sst") ? { upstreams: audioCatalogs }
    : { upstreams: catalogs }
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
}

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  // One value for the whole panel, exactly as the three real surfaces hold it.
  const [value, setValue] = useState<ThreadSettings>({
    model: "deepseek-flash", upstream_id: "up-deepseek", reasoning_effort: "medium", service_tier_fast: false,
    context_budget_tokens: null, minimal_mode: null, image_generation_model: null,
    audio_transcription_model: null, max_loaded_manuals: null, initial_manual_ids: null, budget_usd_nanos: null,
  })
  return <main className="flex min-h-svh flex-col gap-6 p-5">
    <header className="flex items-center gap-3">
      <h1 className="mr-auto text-sm font-semibold">Cybion · Thread settings</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      <span data-testid="selection">{value.upstream_id}:{value.model}</span>
      <span data-testid="effort">{value.reasoning_effort}</span>
      <span data-testid="fast">{String(value.service_tier_fast)}</span>
      <span data-testid="budget">{String(value.context_budget_tokens)}</span>
      <span data-testid="usd-budget">{String(value.budget_usd_nanos)}</span>
      <span data-testid="minimal">{String(value.minimal_mode)}</span>
      <span data-testid="image-model">{String(value.image_generation_model)}</span>
      <span data-testid="audio-model">{String(value.audio_transcription_model)}</span>
      <span data-testid="loaded-cap">{String(value.max_loaded_manuals)}</span>
      <span data-testid="initial-manuals">{JSON.stringify(value.initial_manual_ids)}</span>
    </div>
    <div className="mt-auto flex items-center justify-between gap-3 border-t pt-4">
      <ThreadSettingsPopover value={value} onChange={setValue} language={language} />
      <Button>发送</Button>
    </div>
  </main>
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById("root")!).render(<StrictMode>
  <QueryClientProvider client={queryClient}>
    <CybionThreadProvider baseUrl="https://cybion.test" getToken={() => "token"} fetch={fetch} identity="e2e" language="zh" queryClient={queryClient}>
      <Fixture />
    </CybionThreadProvider>
  </QueryClientProvider>
</StrictMode>)
