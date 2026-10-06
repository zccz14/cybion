import { useState } from "react"
import { ArchiveRestoreIcon, ChevronRightIcon } from "lucide-react"
import { ThreadLink } from "@/components/thread-status"
import { ThreadListControls, ThreadListEmptyState, ThreadListMore, type ThreadListPagination } from "@/components/thread-list-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { allThreadListFilters, type ThreadListFilters } from "@/lib/thread-search"
import type { ThreadDisplayStatus } from "@/lib/thread-status"
import type { ThreadUsage } from "@/lib/thread-usage"

export type ThreadListItem = {
  created_by: "web" | "api"
  external_ref: string | null
  id: string
  title: string
  display_status: ThreadDisplayStatus
  updated_at: number
  usage: ThreadUsage
}

type ThreadListCopyKey = "threads" | "archivedThreads" | "restoreThread"

const copy = {
  en: { threads: "Threads", archivedThreads: "Archived", restoreThread: "Restore" },
  zh: { threads: "线程", archivedThreads: "已归档", restoreThread: "恢复" },
} satisfies Record<"en" | "zh", Record<ThreadListCopyKey, string>>

export function ArchivedThreadGroup({ threads, total, pagination, language, onRestore, restoringId }: { threads: ThreadListItem[]; total: number; pagination: ThreadListPagination; language: "en" | "zh"; onRestore: (id: string) => void; restoringId: string | null }) {
  const t = copy[language]
  const [open, setOpen] = useState(false)
  if (threads.length === 0) return null
  return <div className="mt-3 border-t pt-2">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} className="w-full justify-start text-muted-foreground" onClick={() => setOpen((value) => !value)}>
      <ChevronRightIcon aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-90")} />
      {t.archivedThreads} ({total})
    </Button>
    {open && <nav aria-label={t.archivedThreads} className="mt-1 flex flex-col gap-1">
      {threads.map((thread) => <div key={thread.id} className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1"><ThreadLink thread={thread} language={language} /></div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t.restoreThread} title={t.restoreThread} disabled={restoringId === thread.id} onClick={() => onRestore(thread.id)}>
          {restoringId === thread.id ? <Spinner /> : <ArchiveRestoreIcon aria-hidden="true" />}
        </Button>
      </div>)}
      <ThreadListMore pagination={pagination} language={language} />
    </nav>}
  </div>
}

export function ThreadList({ threads, archivedThreads, archivedTotal, loading, language, filters, onFiltersChange, pagination, archivedPagination, onCreate, onRestore, restoringId }: { threads: ThreadListItem[]; archivedThreads: ThreadListItem[]; archivedTotal: number; loading: boolean; language: "en" | "zh"; filters: ThreadListFilters; onFiltersChange: (filters: ThreadListFilters) => void; pagination: ThreadListPagination; archivedPagination: ThreadListPagination; onCreate: () => void; onRestore: (id: string) => void; restoringId: string | null }) {
  const t = copy[language]
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b p-3">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading
        ? <div className="flex flex-col gap-2"><Skeleton className="h-18" /><Skeleton className="h-18" /><Skeleton className="h-18" /></div>
        : <>
          <nav aria-label={t.threads} className="flex flex-col gap-1">
            {threads.length === 0 && <ThreadListEmptyState filters={filters} language={language} onReset={() => onFiltersChange(allThreadListFilters)} />}
            {threads.map((thread) => <ThreadLink key={thread.id} thread={thread} language={language} />)}
            <ThreadListMore pagination={pagination} language={language} />
          </nav>
          <ArchivedThreadGroup threads={archivedThreads} total={archivedTotal} pagination={archivedPagination} language={language} onRestore={onRestore} restoringId={restoringId} />
        </>}
    </div>
  </div>
}
