import { useEffect, useState } from "react"
import { PlusIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { hasThreadListFilters, type ThreadListFilters, type ThreadListView } from "@/lib/thread-search"

type ThreadListControlsCopyKey = "newThread" | "searchThreads" | "viewsLabel" | "emptyTitle" | "emptyFiltered" | "resetFilters" | ThreadListView

const copy = {
  en: {
    newThread: "New thread",
    searchThreads: "Search titles or external refs",
    viewsLabel: "Thread views",
    all: "All",
    mine: "Mine",
    api: "API",
    running: "Running",
    failed: "Failed",
    emptyTitle: "No threads yet",
    emptyFiltered: "No threads match your filters",
    resetFilters: "Show all",
  },
  zh: {
    newThread: "新建线程",
    searchThreads: "搜索标题或外部引用",
    viewsLabel: "线程视图",
    all: "全部",
    mine: "我的",
    api: "API",
    running: "运行中",
    failed: "失败",
    emptyTitle: "还没有线程",
    emptyFiltered: "没有匹配的线程",
    resetFilters: "回到「全部」",
  },
} satisfies Record<"en" | "zh", Record<ThreadListControlsCopyKey, string>>

const views: ThreadListView[] = ["all", "mine", "api", "running", "failed"]
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
    const query = draft.trim()
    if (query === filters.q) return
    const timer = setTimeout(() => onFiltersChange({ ...filters, q: query }), searchDebounceMs)
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
