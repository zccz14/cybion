import { useEffect, useRef, useState } from "react"
import { PlusIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { THREAD_LIST_VIEWS, hasThreadListFilters, type ThreadListFilters, type ThreadListView } from "@/lib/thread-search"

type ThreadListControlsCopyKey = "newThread" | "searchThreads" | "viewsLabel" | "emptyTitle" | "emptyFiltered" | "resetFilters" | "loadMore" | ThreadListView

const copy = {
  en: {
    newThread: "New thread",
    searchThreads: "Search titles or external refs",
    viewsLabel: "Thread views",
    all: "All",
    mine: "Web",
    api: "API",
    running: "Running",
    failed: "Failed",
    emptyTitle: "No threads yet",
    emptyFiltered: "No threads match your filters",
    resetFilters: "Show all",
    loadMore: "Load more",
  },
  zh: {
    newThread: "新建线程",
    searchThreads: "搜索标题或外部引用",
    viewsLabel: "线程视图",
    all: "全部",
    mine: "网页创建",
    api: "API",
    running: "运行中",
    failed: "失败",
    emptyTitle: "还没有线程",
    emptyFiltered: "没有匹配的线程",
    resetFilters: "显示全部",
    loadMore: "加载更多",
  },
} satisfies Record<"en" | "zh", Record<ThreadListControlsCopyKey, string>>

const views: readonly ThreadListView[] = THREAD_LIST_VIEWS
const searchDebounceMs = 300

export function ThreadListControls({ filters, language, onFiltersChange, onNewThread }: {
  filters: ThreadListFilters
  language: "en" | "zh"
  onFiltersChange: (filters: ThreadListFilters) => void
  onNewThread: () => void
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
      <Button size="icon-sm" variant="outline" aria-label={t.newThread} title={t.newThread} onClick={onNewThread}><PlusIcon /></Button>
    </div>
    <div role="group" aria-label={t.viewsLabel} className="flex flex-wrap items-center gap-1">
      {views.map((view) => <Button key={view} type="button" size="xs" variant={filters.view === view ? "secondary" : "ghost"} aria-pressed={filters.view === view} className="rounded-full px-2" onClick={() => onFiltersChange({ ...filters, view })}>{t[view]}</Button>)}
    </div>
  </div>
}

export function ThreadListEmptyState({ filters, language, onReset }: {
  filters: ThreadListFilters
  language: "en" | "zh"
  onReset: () => void
}) {
  const t = copy[language]
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
