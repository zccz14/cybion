import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadSettingsPopover } from "../src/components/thread-settings-popover"
import "../src/styles.css"

const models = ["deepseek-flash", "gpt-6-astra", "meta-llama/Llama-3.1-8B-Instruct"]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
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
    <div className="mt-auto flex items-center justify-end gap-3 border-t pt-4">
      <span data-testid="model">{model}</span>
      <span data-testid="effort">{effort}</span>
      <span data-testid="fast">{String(fast)}</span>
      <span data-testid="budget">{String(budget)}</span>
      <ThreadSettingsPopover model={model} reasoningEffort={effort} fast={fast} models={models} language={language} contextBudget={{ override: budget, fallback: 200000, onChange: setBudget }} onModelChange={setModel} onReasoningChange={setEffort} onFastChange={setFast} />
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
