import { StrictMode, useCallback, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, useSearchParams } from "react-router-dom"
import { ThreadList, type ThreadListRow } from "../src/components/thread-list"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { parseThreadListFilters, serializeThreadListFilters, type ThreadListFilters } from "../src/lib/thread-search"
import { sharedThreadPath, type SharedThread } from "../src/lib/thread-sharing"
import { CybionMark } from "../src/components/cybion-mark"
import { emptyThreadUsage } from "@zccz14/cybion-components/internal"
import type { ThreadUsage } from "@zccz14/cybion-components/internal"
import type { ThreadListItem } from "../src/components/thread-list"
import "../src/styles.css"

// Ages are relative to page-load time so specs can assert exact labels
// under a fixed Playwright clock.
const now = Math.floor(Date.now() / 1000)

// Rows carry the usage line real Threads show, so the row's secondary line is
// measured with the numbers that actually sit on it.
const spent = (tokens: number, cache: number, usd: number): ThreadUsage => ({
  ...emptyThreadUsage, input_tokens: tokens, output_tokens: Math.round(tokens * 0.03), total_tokens: tokens,
  cached_tokens: Math.round(tokens * cache), cache_hit_rate: cache, cost_usd_nanos: Math.round(usd * 1_000_000_000), cost_settled_requests: 3,
})

const threads: ThreadListItem[] = [
  { id: "worker", title: "修复 Worker 配对与导航", created_by: "api", external_ref: "bridge/task-7", display_status: "running", updated_at: now - 30, usage: spent(2_000_000, 0.932, 0.044), branches: 0 },
  { id: "search", title: "Mobile thread list search", created_by: "web", external_ref: null, display_status: "completed", updated_at: now - 5 * 60, usage: spent(1_600_000, 0.932, 0.00895), branches: 3 },
  { id: "remote", title: "检查远程服务器连接", created_by: "web", external_ref: null, display_status: "failed", updated_at: now - 3 * 3600, usage: spent(1_600_000, 0.922, 0.0436), branches: 0 },
]

const olderSeed: ThreadListItem[] = [
  { id: "older-a", title: "Older thread A", created_by: "web", external_ref: null, display_status: "completed", updated_at: now - 2 * 86400, usage: emptyThreadUsage, branches: 0 },
  { id: "older-b", title: "Older thread B", created_by: "web", external_ref: null, display_status: "completed", updated_at: now - 2 * 86400, usage: emptyThreadUsage, branches: 0 },
]

const archivedSeed: ThreadListItem[] = [
  { id: "legacy", title: "Legacy thread archive", created_by: "web", external_ref: null, display_status: "stopped", updated_at: now - 40 * 86400, usage: emptyThreadUsage, branches: 0 },
]

// The blocked view is its own server-side selection, so the fixture swaps in the
// Threads that wait on the user and leaves every other view's rows untouched.
const blockedSeed: ThreadListItem[] = [
  { id: "blocked", title: "部署卡在缺少生产环境令牌", created_by: "web", external_ref: null, display_status: "blocked", updated_at: now - 10 * 60, usage: emptyThreadUsage, branches: 0 },
]

// A share is somebody else's Thread, so the fixture keeps its own seed: the owner is
// rendered through the Linkit fixture, exactly as the list does in the app.
const sharedSeed: SharedThread[] = [
  { id: "owner-task", owner_user_id: "user-1", grant_id: "g1", access: "viewer", title: "Owner's private task", status: "running", display_status: "running", running_summary: null, usage: emptyThreadUsage, created_at: now - 100, updated_at: now - 30, shared_at: now - 20 },
]

// The fixture mirrors the server-side filter and cursor paging semantics plus
// the app shell's URL filter wiring, so the e2e suite can exercise the shared
// list chrome without a backend.
function fixtureMatches(thread: ThreadListItem, filters: ThreadListFilters) {
  if (filters.view === "mine" && thread.created_by !== "web") return false
  if (filters.view === "api" && thread.created_by !== "api") return false
  if (filters.view === "running" && thread.display_status !== "running" && thread.display_status !== "compacting") return false
  if (filters.view === "failed" && thread.display_status !== "failed") return false
  if (filters.view === "blocked" && thread.display_status !== "blocked") return false
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
  const [shares, setShares] = useState(sharedSeed)
  const [hiddenShares, setHidden] = useState<string[]>([])
  const [toggled, setToggled] = useState("")
  // The filter selection lives in the URL, exactly like the app shell.
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => parseThreadListFilters(searchParams), [searchParams])
  const setFilters = useCallback((next: ThreadListFilters) => setSearchParams(serializeThreadListFilters(next)), [setSearchParams])
  const [pagesLoaded, setPagesLoaded] = useState(1)
  // Every category is the same list read differently: the archived view sits on the other
  // side of `archived_at`, blocked is its own server selection, and shared reads the
  // recipient's index. Everything else — search, empty state, paging, row shape — is shared.
  const archivedView = filters.view === "archived"
  const blockedView = filters.view === "blocked"
  const sharedView = filters.view === "shared"
  const all = archivedView ? archived : blockedView ? blockedSeed : paged ? [...threads, ...olderSeed] : threads
  const matches = all.filter((thread) => fixtureMatches(thread, filters))
  const visible = archivedView ? matches : matches.slice(0, pageSize * pagesLoaded)
  const pagination = { hasMore: !archivedView && visible.length < matches.length, loadingMore: false, onLoadMore: () => setPagesLoaded((count) => count + 1) }
  // The share the viewer put aside, as the endpoint would answer it.
  const sharedMatches = shares.filter((share) => hiddenShares.includes(share.id) === filters.hidden)
  const rows: ThreadListRow[] = sharedView
    ? sharedMatches.map((share) => ({
      key: `${share.owner_user_id}:${share.id}`,
      thread: { ...share, created_by: "web", external_ref: null, branches: 0 },
      to: sharedThreadPath(share.owner_user_id, share.id),
      badge: <span className="shrink-0 rounded border px-1 text-[0.65rem] text-muted-foreground">{share.owner_user_id}</span>,
      action: {
        label: filters.hidden ? "restore" : "hide",
        icon: null,
        pending: false,
        run: () => {
          setHidden((current) => filters.hidden ? current.filter((id) => id !== share.id) : [...current, share.id])
          setToggled(share.id)
        },
      },
    }))
    : visible.map((thread) => ({
      key: thread.id,
      thread,
      to: `/threads/${thread.id}`,
      action: archivedView
        ? { label: "restore", icon: null, pending: false, run: () => { setArchived((items) => items.filter((item) => item.id !== thread.id)); setRestored(thread.id) } }
        : undefined,
    }))
  return <main className="flex h-svh flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-3 border-b p-3">
      <CybionMark className="size-5" />
      <h1 className="mr-auto text-sm font-semibold">Cybion · Thread list</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <span data-testid="created">{created}</span>
      <span data-testid="restored">{restored}</span>
      <span data-testid="toggled">{toggled}</span>
    </header>
    <ThreadList
      rows={rows}
      loading={false}
      language={language}
      filters={filters}
      onFiltersChange={setFilters}
      pagination={sharedView ? { hasMore: false, loadingMore: false, onLoadMore: () => undefined } : pagination}
      onCreate={() => setCreated((value) => value + 1)}
      blockedThreads={blockedSeed.length}
      hiddenShares={sharedView ? { active: filters.hidden, onToggle: () => setFilters({ ...filters, hidden: !filters.hidden }) } : undefined}
    />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider delayDuration={0}><HashRouter><Fixture /></HashRouter></TooltipProvider></StrictMode>)
