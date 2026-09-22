import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThreadList, type ThreadListItem } from "../src/components/thread-list"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { emptyThreadUsage } from "../src/lib/thread-usage"
import "../src/styles.css"

const threads: ThreadListItem[] = [
  { id: "worker", title: "修复 Worker 配对与导航", display_status: "running", usage: emptyThreadUsage },
  { id: "search", title: "Mobile thread list search", display_status: "completed", usage: emptyThreadUsage },
  { id: "remote", title: "检查远程服务器连接", display_status: "failed", usage: emptyThreadUsage },
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [created, setCreated] = useState(0)
  return <main className="flex h-svh flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-3 border-b p-3">
      <img src="/cybion-mark.png" alt="" className="size-5 dark:invert" />
      <h1 className="mr-auto text-sm font-semibold">Cybion · Thread list</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <span data-testid="created">{created}</span>
    </header>
    <ThreadList threads={threads} loading={false} language={language} onCreate={() => setCreated((value) => value + 1)} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider delayDuration={0}><HashRouter><Fixture /></HashRouter></TooltipProvider></StrictMode>)
