import { useState } from "react"
import { ArchiveRestoreIcon, ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react"
import { ThreadLink } from "@/components/thread-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { matchesThreadQuery } from "@/lib/thread-search"
import type { ThreadDisplayStatus } from "@/lib/thread-status"
import type { ThreadUsage } from "@/lib/thread-usage"

export type ThreadListItem = {
  purpose?: "work" | "reports"
  id: string
  title: string
  display_status: ThreadDisplayStatus
  usage: ThreadUsage
}

type ThreadListCopyKey = "threads" | "newThread" | "searchThreads" | "emptyTitle" | "emptySearch" | "archivedThreads" | "restoreThread"

const copy = {
  en: { threads: "Threads", newThread: "New thread", searchThreads: "Search thread titles", emptyTitle: "No threads yet", emptySearch: "No threads match your search", archivedThreads: "Archived", restoreThread: "Restore" },
  zh: { threads: "线程", newThread: "新建线程", searchThreads: "搜索线程标题", emptyTitle: "还没有线程", emptySearch: "没有匹配的线程", archivedThreads: "已归档", restoreThread: "恢复" },
} satisfies Record<"en" | "zh", Record<ThreadListCopyKey, string>>

export function ArchivedThreadGroup({ threads, language, onRestore, restoringId }: { threads: ThreadListItem[]; language: "en" | "zh"; onRestore: (id: string) => void; restoringId: string | null }) {
  const t = copy[language]
  const [open, setOpen] = useState(false)
  if (threads.length === 0) return null
  return <div className="mt-3 border-t pt-2">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} className="w-full justify-start text-muted-foreground" onClick={() => setOpen((value) => !value)}>
      <ChevronRightIcon aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      {t.archivedThreads} ({threads.length})
    </Button>
    {open && <nav aria-label={t.archivedThreads} className="mt-1 flex flex-col gap-1">
      {threads.map((thread) => <div key={thread.id} className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1"><ThreadLink thread={thread} language={language} /></div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t.restoreThread} title={t.restoreThread} disabled={restoringId === thread.id} onClick={() => onRestore(thread.id)}>
          {restoringId === thread.id ? <Spinner /> : <ArchiveRestoreIcon aria-hidden="true" />}
        </Button>
      </div>)}
    </nav>}
  </div>
}

export function ThreadList({ threads, archivedThreads, loading, language, onCreate, onRestore, restoringId }: { threads: ThreadListItem[]; archivedThreads: ThreadListItem[]; loading: boolean; language: "en" | "zh"; onCreate: () => void; onRestore: (id: string) => void; restoringId: string | null }) {
  const t = copy[language]
  const [query, setQuery] = useState("")
  const visible = threads.filter((thread) => matchesThreadQuery(thread, query))
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b p-3">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" aria-label={t.searchThreads} placeholder={t.searchThreads} className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Button size="icon-sm" variant="outline" aria-label={t.newThread} onClick={onCreate}><PlusIcon /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading
        ? <div className="flex flex-col gap-2"><Skeleton className="h-18" /><Skeleton className="h-18" /><Skeleton className="h-18" /></div>
        : <>
          <nav aria-label={t.threads} className="flex flex-col gap-1">
            {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{query.trim() ? t.emptySearch : t.emptyTitle}</p>}
            {visible.map((thread) => <ThreadLink key={thread.id} thread={thread} language={language} />)}
          </nav>
          <ArchivedThreadGroup threads={archivedThreads} language={language} onRestore={onRestore} restoringId={restoringId} />
        </>}
    </div>
  </div>
}
