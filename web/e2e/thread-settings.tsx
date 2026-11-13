import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadSettingsPopover, type ModelCatalog } from "@zccz14/cybion-components"
import { Button } from "../src/components/ui/button"
import "../src/styles.css"

const catalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash", "gpt-6-astra"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["meta-llama/Llama-3.1-8B-Instruct"], error: "Could not load models" },
]

// Image models follow the Thread's upstream: up-deepseek and up-lb serve
// different lists, and the popover narrows to the selected upstream.
// The Manuals the picker may name, exactly as `GET /api/manual-summaries`
// answers them: ids and names, no bodies.
const manualChoices = [
  { manual_id: "11111111-1111-4111-8111-111111111111", name: "必读手册" },
  { manual_id: "22222222-2222-4222-8222-222222222222", name: "Codex 指南" },
  { manual_id: "33333333-3333-4333-8333-333333333333", name: "前端开发指南" },
]

const audioCatalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["whisper-1"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["gpt-4o-transcribe"], error: null },
]

const imageCatalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["gpt-image-2"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["gpt-image-2-mini"], error: null },
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [upstreamId, setUpstreamId] = useState<string | null>("up-deepseek")
  const [model, setModel] = useState("deepseek-flash")
  const [effort, setEffort] = useState("medium")
  const [fast, setFast] = useState(false)
  const [budget, setBudget] = useState<number | null>(null)
  const [minimal, setMinimal] = useState<boolean | null>(null)
  const [imageModel, setImageModel] = useState<string | null>(null)
  const [audioModel, setAudioModel] = useState<string | null>(null)
  const [loadedCap, setLoadedCap] = useState<number | null>(null)
  const [initialManuals, setInitialManuals] = useState<string[] | null>(null)
  return <main className="flex min-h-svh flex-col gap-6 p-5">
    <header className="flex items-center gap-3">
      <h1 className="mr-auto text-sm font-semibold">Cybion · Thread settings</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
      <span data-testid="selection">{upstreamId}:{model}</span>
      <span data-testid="effort">{effort}</span>
      <span data-testid="fast">{String(fast)}</span>
      <span data-testid="budget">{String(budget)}</span>
      <span data-testid="minimal">{String(minimal)}</span>
      <span data-testid="image-model">{String(imageModel)}</span>
      <span data-testid="audio-model">{String(audioModel)}</span>
      <span data-testid="loaded-cap">{String(loadedCap)}</span>
      <span data-testid="initial-manuals">{JSON.stringify(initialManuals)}</span>
    </div>
    <div className="mt-auto flex items-center justify-between gap-3 border-t pt-4">
      <ThreadSettingsPopover model={model} upstreamId={upstreamId} catalogs={catalogs} reasoningEffort={effort} fast={fast} language={language} contextBudget={{ override: budget, fallback: 200000, onChange: setBudget }} minimalMode={{ override: minimal, fallback: false, onChange: setMinimal }} imageGeneration={{ override: imageModel, fallback: "gpt-image-2", catalogs: imageCatalogs, onChange: setImageModel }} audioTranscription={{ override: audioModel, fallback: "whisper-1", catalogs: audioCatalogs, onChange: setAudioModel }} loadedManualCap={{ override: loadedCap, fallback: 12, onChange: setLoadedCap }} initialManuals={{ override: initialManuals, fallback: [manualChoices[0].manual_id], catalogs: manualChoices, onChange: setInitialManuals }} onModelChange={(upstreamId, model) => { setUpstreamId(upstreamId); setModel(model) }} onReasoningChange={setEffort} onFastChange={setFast} />
      <Button>发送</Button>
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
