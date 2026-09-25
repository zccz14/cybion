import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadSettingsPopover, type ModelCatalog } from "../src/components/thread-settings-popover"
import { Button } from "../src/components/ui/button"
import "../src/styles.css"

const catalogs: ModelCatalog[] = [
  { id: "up-deepseek", name: "DeepSeek", models: ["deepseek-flash", "gpt-6-astra"], error: null },
  { id: "up-lb", name: "OpenAI-LB", models: ["meta-llama/Llama-3.1-8B-Instruct"], error: "Could not load models" },
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [upstreamId, setUpstreamId] = useState<string | null>("up-deepseek")
  const [model, setModel] = useState("deepseek-flash")
  const [effort, setEffort] = useState("medium")
  const [fast, setFast] = useState(false)
  const [budget, setBudget] = useState<number | null>(null)
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
    </div>
    <div className="mt-auto flex items-center justify-between gap-3 border-t pt-4">
      <ThreadSettingsPopover model={model} upstreamId={upstreamId} catalogs={catalogs} reasoningEffort={effort} fast={fast} language={language} contextBudget={{ override: budget, fallback: 200000, onChange: setBudget }} onModelChange={(upstreamId, model) => { setUpstreamId(upstreamId); setModel(model) }} onReasoningChange={setEffort} onFastChange={setFast} />
      <Button>发送</Button>
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
