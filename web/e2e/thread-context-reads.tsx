import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import type { ContextSummary } from "../src/components/cybion-tool-call"
import { ThreadContextReads } from "../src/components/thread-context-reads"
import type { ThreadContextRead } from "../src/lib/thread-context-reads"
import "../src/styles.css"

const manual = "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"
const unknown = "c0ffee00-1111-2222-3333-444455556666"
const reads: ThreadContextRead[] = [
  { context_id: manual, calls: 2, first_record_id: 11, last_record_id: 27, last_read_at: 27 },
  { context_id: unknown, calls: 1, first_record_id: 30, last_record_id: 30, last_read_at: 30 },
]
const lookup: ReadonlyMap<string, ContextSummary> = new Map([[manual, { name: "必读上下文", description: "标准手册" }]])

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-4">
    <header className="flex flex-wrap gap-2">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div id="reads"><ThreadContextReads reads={reads} lookup={lookup} view={{ head: 10, tail: 31 }} language={language} /></div>
    <div id="empty"><ThreadContextReads reads={[]} lookup={lookup} view={{ head: 40, tail: 41 }} language={language} /></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><HashRouter><Fixture /></HashRouter></StrictMode>)
