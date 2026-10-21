import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import type { ManualSummary } from "../src/components/cybion-tool-call"
import { ManualLoadNotice } from "../src/components/manual-load-notice"
import { ThreadManualLoads } from "../src/components/thread-manual-loads"
import "../src/styles.css"

const manual = "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"
const edited = "c0ffee00-1111-2222-3333-444455556666"
const unknown = "99998888-7777-6666-5555-444433332222"
const lookup: ReadonlyMap<string, ManualSummary> = new Map([
  [manual, { name: "必读手册", description: "标准手册" }],
  [edited, { name: "LOL-MODEL", description: "模型与回测" }],
])

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-4">
    <header className="flex flex-wrap gap-2">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div id="loaded"><ThreadManualLoads view={{ head: 10, tail: 32, loaded: [manual, edited] }} lookup={lookup} language={language} /></div>
    <div id="unknown"><ThreadManualLoads view={{ head: 50, tail: 60, loaded: [edited, unknown] }} lookup={lookup} language={language} /></div>
    <div id="empty"><ThreadManualLoads view={{ head: 40, tail: 41, loaded: [] }} lookup={lookup} language={language} /></div>
    <div id="load-notice"><ManualLoadNotice notice={{ manual_id: manual, loaded: true }} lookup={lookup} language={language} time="10:01" recordId={43} /></div>
    <div id="unload-notice"><ManualLoadNotice notice={{ manual_id: edited, loaded: false }} lookup={lookup} language={language} time="10:02" recordId={44} /></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><HashRouter><Fixture /></HashRouter></StrictMode>)
