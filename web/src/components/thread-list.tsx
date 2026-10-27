import { useState } from "react"
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestoreIcon, ChevronRightIcon } from "lucide-react"
import { ThreadLink } from "@/components/thread-status"
import { ThreadListControls, ThreadListEmptyState, ThreadListMore, type ThreadListPagination } from "@/components/thread-list-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn, errorMessage } from "@/lib/utils"
import { allThreadListFilters, mergeThreadPages, threadListUrl, type ThreadListFilters } from "@/lib/thread-search"
import type { ThreadDisplayStatus } from "@/lib/thread-status"
import type { ThreadUsage } from "@/lib/thread-usage"

export type ThreadListItem = {
  created_by: "web" | "api"
  external_ref: string | null
  id: string
  title: string
  display_status: ThreadDisplayStatus
  running_summary: string | null
  updated_at: number
  usage: ThreadUsage
}

type ThreadListCopyKey = "threads" | "archivedThreads" | "restoreThread"

const copy = {
  en: { threads: "Conversations", archivedThreads: "Archived", restoreThread: "Restore" },
  zh: { threads: "对话", archivedThreads: "已归档", restoreThread: "恢复" },
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

export type ThreadListRequest = <T>(path: string, init?: RequestInit) => Promise<T>

type ThreadPage = { items: ThreadListItem[]; next_cursor: string | null; total: number }

// The list polls itself: titles, statuses and usage written by any origin — the
// browser, the integration API, a Worker turn still running — arrive within one
// interval, and every screen that shows the list shows the same fresh rows.
const threadListPollMs = 2000

// INVARIANT: the Thread List owns the threads. No page, shell or conversation above
// it fetches, holds or polls thread rows, so opening a Thread cannot refetch the list,
// and the list is never unmounted by a Thread switch.
function useThreadList({ sessionId, request, filters }: { sessionId: string | null | undefined; request: ThreadListRequest; filters: ThreadListFilters }) {
  const client = useQueryClient()
  const threads = useInfiniteQuery({
    queryKey: ["threads", sessionId, threadListUrl(filters)],
    queryFn: ({ pageParam }) => request<ThreadPage>(threadListUrl(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: threadListPollMs,
    // One polling window is already fresh, so a list that remounts inside it reads the
    // cache instead of asking the server for rows it would have polled a moment later.
    staleTime: threadListPollMs,
    placeholderData: keepPreviousData,
  })
  const archived = useInfiniteQuery({
    queryKey: ["threads", sessionId, "archived"],
    queryFn: ({ pageParam }) => request<ThreadPage>(threadListUrl(allThreadListFilters, pageParam, true)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: threadListPollMs,
    staleTime: threadListPollMs,
  })
  // Restoring is a list action on a list row, so the mutation and the refresh it
  // triggers stay with the list instead of travelling through the page above.
  const restore = useMutation({
    mutationFn: (threadId: string) => request<{ id: string }>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }),
    onSuccess: (thread) => {
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["thread", thread.id] })
    },
  })
  return {
    threads: mergeThreadPages(threads.data?.pages.map((page) => page.items) ?? []),
    archivedThreads: mergeThreadPages(archived.data?.pages.map((page) => page.items) ?? []),
    archivedTotal: archived.data?.pages[0]?.total ?? 0,
    loading: threads.isLoading,
    error: threads.error,
    pagination: { hasMore: threads.hasNextPage, loadingMore: threads.isFetchingNextPage, onLoadMore: () => { void threads.fetchNextPage() } },
    archivedPagination: { hasMore: archived.hasNextPage, loadingMore: archived.isFetchingNextPage, onLoadMore: () => { void archived.fetchNextPage() } },
    restoringId: restore.isPending ? restore.variables ?? null : null,
    onRestore: restore.mutate,
  }
}

// The one Thread List the app renders anywhere: the narrow-screen page, the sidebar
// beside a new conversation, and the sidebar beside an open one. `page` fills the
// screen, `sidebar` is the compact column a page lays out next to the conversation.
export function ThreadListPane({ layout = "page", sessionId, request, language, filters, onFiltersChange, onCreate }: {
  layout?: "page" | "sidebar"
  sessionId: string | null | undefined
  request: ThreadListRequest
  language: "en" | "zh"
  filters: ThreadListFilters
  onFiltersChange: (filters: ThreadListFilters) => void
  onCreate: () => void
}) {
  const list = useThreadList({ sessionId, request, filters })
  const failure = Boolean(list.error) && <p className="px-3 py-2 text-xs text-destructive">{errorMessage(list.error)}</p>
  if (layout === "page") return <>
    <ThreadList threads={list.threads} archivedThreads={list.archivedThreads} archivedTotal={list.archivedTotal} loading={list.loading} language={language} filters={filters} onFiltersChange={onFiltersChange} pagination={list.pagination} archivedPagination={list.archivedPagination} onCreate={onCreate} onRestore={list.onRestore} restoringId={list.restoringId} />
    {failure}
  </>
  return <>
    <div className="pb-2">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} />
    </div>
    <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-12rem)]" aria-label={copy[language].threads}>
      {list.loading && <div className="flex flex-col gap-2 px-2 py-1"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>}
      {!list.loading && list.threads.length === 0 && <ThreadListEmptyState filters={filters} language={language} onReset={() => onFiltersChange(allThreadListFilters)} />}
      {!list.loading && list.threads.map((thread) => <ThreadLink key={thread.id} thread={thread} language={language} />)}
      <ThreadListMore pagination={list.pagination} language={language} />
      <ArchivedThreadGroup threads={list.archivedThreads} total={list.archivedTotal} pagination={list.archivedPagination} language={language} onRestore={list.onRestore} restoringId={list.restoringId} />
      {failure}
    </nav>
  </>
}
