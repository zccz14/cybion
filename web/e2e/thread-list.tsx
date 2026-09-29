import { StrictMode, useCallback, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, useSearchParams } from "react-router-dom"
import { ThreadList, type ThreadListItem } from "../src/components/thread-list"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { parseThreadListFilters, serializeThreadListFilters, type ThreadListFilters } from "../src/lib/thread-search"
import { emptyThreadUsage } from "../src/lib/thread-usage"
import "../src/styles.css"

const threads: ThreadListItem[] = [
  { id: "worker", title: "修复 Worker 配对与导航", created_by: "api", external_ref: "bridge/task-7", display_status: "running", usage: emptyThreadUsage },
  { id: "search", title: "Mobile thread list search", created_by: "web", external_ref: null, display_status: "completed", usage: emptyThreadUsage },
  { id: "remote", title: "检查远程服务器连接", created_by: "web", external_ref: null, display_status: "failed", usage: emptyThreadUsage },
]

const olderSeed: ThreadListItem[] = [
  { id: "older-a", title: "Older thread A", created_by: "web", external_ref: null, display_status: "completed", usage: emptyThreadUsage },
  { id: "older-b", title: "Older thread B", created_by: "web", external_ref: null, display_status: "completed", usage: emptyThreadUsage },
]

const archivedSeed: ThreadListItem[] = [
  { id: "legacy", title: "Legacy thread archive", created_by: "web", external_ref: null, display_status: "stopped", usage: emptyThreadUsage },
]

// The fixture mirrors the server-side filter and cursor paging semantics plus
// the app shell's URL filter wiring, so the e2e suite can exercise the shared
// list chrome without a backend.
function fixtureMatches(thread: ThreadListItem, filters: ThreadListFilters) {
  if (filters.view === "mine" && thread.created_by !== "web") return false
  if (filters.view === "api" && thread.created_by !== "api") return false
  if (filters.view === "running" && thread.display_status !== "running" && thread.display_status !== "compacting") return false
  if (filters.view === "failed" && thread.display_status !== "failed") return false
  const query = filters.q.trim().toLowerCase()
  if (query === "") return true
  return thread.title.toLowerCase().includes(query) || (thread.external_ref ?? "").toLowerCase().includes(query)
}

const pageSize = 3
const paged = new URLSearchParams(window.location.search).has("paged")

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [created, setCreated] = useState(0)
  const [archived, setArchived] = useState(archivedSeed)
  const [restored, setRestored] = useState("")
  // The filter selection lives in the URL, exactly like the app shell.
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseThreadListFilters(searchParams), [searchParams])
  const setFilters = useCallback((next: ThreadListFilters) => setSearchParams(serializeThreadListFilters(next)), [setSearchParams])
  const [pagesLoaded, setPagesLoaded] = useState(1)
  const all = paged ? [...threads, ...olderSeed] : threads
  const matches = all.filter((thread) => fixtureMatches(thread, filters))
  const visible = matches.slice(0, pageSize * pagesLoaded)
  const pagination = { hasMore: visible.length < matches.length, loadingMore: false, onLoadMore: () => setPagesLoaded((count) => count + 1) }
  const archivedPagination = { hasMore: false, loadingMore: false, onLoadMore: () => {} }
  return <main className="flex h-svh flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-3 border-b p-3">
      <img src="/cybion-mark.png" alt="" className="size-5 dark:invert" />
      <h1 className="mr-auto text-sm font-semibold">Cybion · Thread list</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <span data-testid="created">{created}</span>
      <span data-testid="restored">{restored}</span>
    </header>
    <ThreadList threads={visible} archivedThreads={archived} archivedTotal={archived.length} loading={false} language={language} filters={filters} onFiltersChange={setFilters} pagination={pagination} archivedPagination={archivedPagination} onCreate={() => setCreated((value) => value + 1)} onRestore={(id) => { setArchived((items) => items.filter((item) => item.id !== id)); setRestored(id) }} restoringId={null} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider delayDuration={0}><HashRouter><Fixture /></HashRouter></TooltipProvider></StrictMode>)
