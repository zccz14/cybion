import { useEffect, useRef, useState } from "react"
import { EyeOffIcon, PlusIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { THREAD_LIST_VIEWS, hasThreadListFilters, type ThreadListFilters, type ThreadListView } from "@/lib/thread-search"
import type { ThreadListHiddenShares } from "@/components/thread-list"

type ThreadListControlsCopyKey = "newThread" | "searchThreads" | "viewsLabel" | "emptyTitle" | "emptyArchived" | "emptyShared" | "emptyHiddenShares" | "emptyPage" | "emptyFiltered" | "resetFilters" | "loadMore" | "blockedCount" | "hiddenShares" | "visibleShares" | ThreadListView

const copy = {
  en: {
    newThread: "New conversation",
    searchThreads: "Search titles or external refs",
    viewsLabel: "Conversation views",
    all: "All",
    mine: "Web",
    api: "API",
    running: "Running",
    failed: "Failed",
    blocked: "Blocked",
    blockedCount: "Threads waiting on you",
    archived: "Archived",
    shared: "Shared with me",
    emptyTitle: "No conversations yet",
    emptyArchived: "No archived conversations",
    emptyShared: "Nobody has shared a Thread with you yet.",
    emptyHiddenShares: "No hidden shares.",
    emptyPage: "No accessible shares on this page. Load more to continue.",
    emptyFiltered: "No conversations match your filters",
    resetFilters: "Show all",
    loadMore: "Load more",
    hiddenShares: "Hidden shares",
    visibleShares: "Visible shares",
  },
  zh: {
    newThread: "新建对话",
    searchThreads: "搜索标题或外部引用",
    viewsLabel: "对话视图",
    all: "全部",
    mine: "网页创建",
    api: "API",
    running: "运行中",
    failed: "失败",
    blocked: "受阻",
    blockedCount: "正在等你的线程数",
    archived: "已归档",
    shared: "分享给我",
    emptyTitle: "还没有对话。点击「新建对话」即可开始。",
    emptyArchived: "还没有归档的对话",
    emptyShared: "还没有人把 Thread 分享给你。",
    emptyHiddenShares: "没有隐藏的分享。",
    emptyPage: "本页没有可访问的分享，请加载更多。",
    emptyFiltered: "没有匹配的对话",
    resetFilters: "显示全部",
    loadMore: "加载更多",
    hiddenShares: "已隐藏的分享",
    visibleShares: "未隐藏的分享",
  },
} satisfies Record<"en" | "zh", Record<ThreadListControlsCopyKey, string>>

const views: readonly ThreadListView[] = THREAD_LIST_VIEWS
const searchDebounceMs = 300

export function ThreadListControls({ filters, language, onFiltersChange, onNewThread, blockedThreads, hiddenShares }: {
  filters: ThreadListFilters
  language: "en" | "zh"
  onFiltersChange: (filters: ThreadListFilters) => void
  onNewThread: () => void
  /** Threads waiting on the user; the blocked chip carries the count. */
  blockedThreads?: number
  /** Inside the shared category, the shares this account put aside. */
  hiddenShares?: ThreadListHiddenShares
}) {
  const t = copy[language]
  const [draft, setDraft] = useState(filters.q)
  useEffect(() => {
    setDraft(filters.q)
  }, [filters.q])
  useEffect(() => {
    if (draft.trim() === filters.q.trim()) return
    const timer = setTimeout(() => onFiltersChange({ ...filters, q: draft }), searchDebounceMs)
    return () => clearTimeout(timer)
  }, [draft, filters, onFiltersChange])
  return <div className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" aria-label={t.searchThreads} placeholder={t.searchThreads} className="pl-8" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
      <Button size="sm" className="shrink-0" variant="outline" aria-label={t.newThread} onClick={onNewThread}><PlusIcon />{t.newThread}</Button>
    </div>
    <div role="group" aria-label={t.viewsLabel} className="flex flex-wrap items-center gap-1">
      {views.map((view) => <Button key={view} type="button" size="xs" variant={filters.view === view ? "secondary" : "ghost"} aria-pressed={filters.view === view} className="rounded-full px-2" onClick={() => onFiltersChange({ ...filters, view })}>
        {t[view]}
        {view === "blocked" && blockedThreads !== undefined && blockedThreads > 0 && <span title={t.blockedCount} className="ml-1 rounded-full bg-current/15 px-1.5 text-[0.65rem] tabular-nums">{blockedThreads}</span>}
      </Button>)}
      {/* Hiding is a local choice about somebody else's Thread, so it is a toggle inside
          the shared category rather than a category of its own. */}
      {hiddenShares && <Button type="button" size="xs" variant={hiddenShares.active ? "secondary" : "ghost"} aria-pressed={hiddenShares.active} className="rounded-full px-2" onClick={hiddenShares.onToggle}>
        <EyeOffIcon />{hiddenShares.active ? t.hiddenShares : t.visibleShares}
      </Button>}
    </div>
  </div>
}

export function ThreadListEmptyState({ filters, language, hasMore, onReset }: {
  filters: ThreadListFilters
  language: "en" | "zh"
  /** A short page of shares can still hold more behind the cursor. */
  hasMore?: boolean
  onReset: () => void
}) {
  const t = copy[language]
  // The archived view has its own empty line: it is a roster of Threads that
  // were put away, so "no conversations yet" would be a lie and there is
  // nothing to widen with Show all.
  if (filters.view === "archived" && filters.q.trim() === "") return <p className="px-3 py-2 text-sm text-muted-foreground">{t.emptyArchived}</p>
  // Sharing is not searchable across owners, so an empty shared page means either
  // "nothing hidden" or "nothing left on this page, keep walking".
  if (filters.view === "shared") return <p className="px-3 py-2 text-sm text-muted-foreground">{hasMore ? t.emptyPage : filters.hidden ? t.emptyHiddenShares : t.emptyShared}</p>
  if (!hasThreadListFilters(filters)) return <p className="px-3 py-2 text-sm text-muted-foreground">{t.emptyTitle}</p>
  return <div className="flex flex-col items-start gap-2 px-3 py-2">
    <p className="text-sm text-muted-foreground">{t.emptyFiltered}</p>
    <Button type="button" size="xs" variant="outline" onClick={onReset}>{t.resetFilters}</Button>
  </div>
}

export type ThreadListPagination = { hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }

export function ThreadListMore({ pagination, language }: { pagination: ThreadListPagination; language: "en" | "zh" }) {
  const t = copy[language]
  const container = useRef<HTMLDivElement>(null)
  const current = useRef(pagination)
  useEffect(() => {
    current.current = pagination
  })
  useEffect(() => {
    const node = container.current
    if (!node || !pagination.hasMore) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      const state = current.current
      if (state.hasMore && !state.loadingMore) state.onLoadMore()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [pagination.hasMore])
  if (!pagination.hasMore) return null
  return <div ref={container} className="flex justify-center py-1">
    <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" disabled={pagination.loadingMore} onClick={() => pagination.onLoadMore()}>
      {pagination.loadingMore && <Spinner className="size-3" />}
      {t.loadMore}
    </Button>
  </div>
}
