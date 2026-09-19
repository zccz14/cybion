import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThreadLink, ThreadStatusBadge } from "../src/components/thread-status"
import { TooltipProvider } from "../src/components/ui/tooltip"
import type { ThreadDisplayStatus } from "../src/lib/thread-status"
import { emptyThreadUsage } from "../src/lib/thread-usage"
import "../src/styles.css"

const statuses: ThreadDisplayStatus[] = ["running", "completed", "failed", "stopped", "ready", "compacting"]
const titles = ["重新设计 Thread 列表的状态展示", "修复 Worker 配对与导航", "检查远程服务器连接", "整理历史执行记录", "准备新任务", "压缩长期研究任务的上下文与保存完整执行记录"]
function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [runningStatus, setRunningStatus] = useState<ThreadDisplayStatus>("running")
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <header className="mb-5 flex flex-wrap items-center gap-3 border-b pb-4">
      <img src="/cybion-mark.png" alt="" className="size-6 dark:invert" />
      <h1 className="mr-auto font-semibold">Cybion · Thread status</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <button onClick={() => setRunningStatus("completed")}>Complete</button>
    </header>
    <div className="flex flex-col gap-6 lg:flex-row">
      <aside className="w-full rounded-xl border bg-sidebar/40 p-3 lg:w-64 lg:shrink-0">
        <h2 className="px-3 pb-3 text-xs font-medium text-muted-foreground">{language === "zh" ? "线程" : "Threads"}</h2>
        <nav aria-label="Threads" className="flex flex-col gap-1">
          {statuses.map((status, index) => <ThreadLink key={status} thread={{ id: status, title: titles[index], display_status: status === "running" ? runningStatus : status, usage: emptyThreadUsage }} language={language} />)}
        </nav>
      </aside>
      <section className="min-w-0 flex-1 rounded-xl border bg-card p-5">
        <h2 className="mb-5 font-medium">{language === "zh" ? "统一的执行状态" : "Execution status"}</h2>
        <div className="flex flex-wrap gap-3" data-testid="badges">{statuses.map((status) => <ThreadStatusBadge key={status} status={status === "running" ? runningStatus : status} language={language} />)}</div>
      </section>
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider><HashRouter><Fixture /></HashRouter></TooltipProvider></StrictMode>)
