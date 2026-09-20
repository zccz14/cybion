import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThreadLink } from "../src/components/thread-status"
import { ThreadUsagePanel } from "../src/components/thread-usage"
import { emptyThreadUsage, type ThreadUsage } from "../src/lib/thread-usage"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "../src/styles.css"

function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("zh")
  const [usage, setUsage] = useState<ThreadUsage>({ input_tokens: 1000000, output_tokens: 234567, total_tokens: 1234567, cached_tokens: 750000, cache_hit_rate: 0.75 })
  return <main className="p-4">
    <header className="mb-4 flex flex-wrap gap-3"><button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button><button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button><button onClick={() => setUsage({ ...usage, total_tokens: usage.total_tokens + 1000, input_tokens: usage.input_tokens + 1000, cache_hit_rate: usage.cached_tokens / (usage.input_tokens + 1000) })}>Poll update</button><button onClick={() => setUsage({ ...usage, cache_hit_rate: null })}>No cache data</button></header>
    <div className="flex flex-col gap-4 lg:flex-row">
      <nav aria-label="Threads" className="w-full rounded-lg border bg-sidebar/40 p-3 lg:w-64 lg:shrink-0">
        <ThreadLink thread={{ id: "measured", title: "长线程 · 累计用量", display_status: "running", usage }} language={language} />
        <ThreadLink thread={{ id: "empty", title: "New thread", display_status: "ready", usage: emptyThreadUsage }} language={language} />
        <ThreadLink thread={{ id: "zero", title: "No cache hit", display_status: "completed", usage: { ...emptyThreadUsage, input_tokens: 100, total_tokens: 100, cache_hit_rate: 0 } }} language={language} />
        <ThreadLink thread={{ id: "large", title: "Very large usage", display_status: "completed", usage: { ...emptyThreadUsage, input_tokens: 1000000000000, total_tokens: 1000000000000, cached_tokens: 1000000000000, cache_hit_rate: 1 } }} language={language} />
      </nav>
      <section className="min-w-0 flex-1 rounded-lg border bg-card"><ThreadUsagePanel usage={usage} language={language} /></section>
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider><HashRouter><Fixture /></HashRouter></TooltipProvider></StrictMode>)
