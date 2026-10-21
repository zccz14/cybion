import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import type { ContextSummary } from "../src/components/cybion-tool-call"
import { ContextLoadNotice } from "../src/components/context-load-notice"
import { ThreadContextLoads } from "../src/components/thread-context-loads"
import "../src/styles.css"

const manual = "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"
const edited = "c0ffee00-1111-2222-3333-444455556666"
const unknown = "99998888-7777-6666-5555-444433332222"
const lookup: ReadonlyMap<string, ContextSummary> = new Map([
  [manual, { name: "必读上下文", description: "标准手册" }],
  [edited, { name: "LOL-MODEL", description: "模型与回测" }],
])

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-4">
    <header className="flex flex-wrap gap-2">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div id="loaded"><ThreadContextLoads view={{ head: 10, tail: 32, loaded: [manual, edited] }} lookup={lookup} language={language} /></div>
    <div id="unknown"><ThreadContextLoads view={{ head: 50, tail: 60, loaded: [edited, unknown] }} lookup={lookup} language={language} /></div>
    <div id="empty"><ThreadContextLoads view={{ head: 40, tail: 41, loaded: [] }} lookup={lookup} language={language} /></div>
    <div id="load-notice"><ContextLoadNotice notice={{ context_id: manual, loaded: true }} lookup={lookup} language={language} time="10:01" recordId={43} /></div>
    <div id="unload-notice"><ContextLoadNotice notice={{ context_id: edited, loaded: false }} lookup={lookup} language={language} time="10:02" recordId={44} /></div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><HashRouter><Fixture /></HashRouter></StrictMode>)
