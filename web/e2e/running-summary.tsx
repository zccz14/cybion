import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThreadLink, ThreadStatusBadge } from "../src/components/thread-status"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { emptyThreadUsage } from "../src/lib/thread-usage"
import "../src/styles.css"

const updated_at = Math.floor(Date.now() / 1000) - 30
const summary = "检查 Node 版本是否满足构建要求"

function Fixture() {
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <nav aria-label="Threads" className="flex w-full max-w-80 flex-col gap-1">
      <ThreadLink thread={{ id: "working", title: "升级构建依赖", display_status: "running", running_summary: summary, updated_at, usage: emptyThreadUsage }} language="zh" />
      <ThreadLink thread={{ id: "thinking", title: "整理执行记录", display_status: "running", running_summary: null, updated_at, usage: emptyThreadUsage }} language="zh" />
    </nav>
    <div data-testid="badges" className="mt-4 flex flex-wrap gap-3">
      <ThreadStatusBadge status="running" runningSummary={summary} language="zh" />
      <ThreadStatusBadge status="running" runningSummary={null} language="zh" />
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<TooltipProvider><HashRouter><Fixture /></HashRouter></TooltipProvider>)
