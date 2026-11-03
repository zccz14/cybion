import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestoreIcon } from "lucide-react"
import { ThreadLink } from "@/components/thread-status"
import { ThreadListControls, ThreadListEmptyState, ThreadListMore, type ThreadListPagination } from "@/components/thread-list-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/utils"
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

// One row, on either side of `archived_at`. An archived row keeps the row shape
// every other row has and adds the one action that belongs to it, so the
// archived view reads as the same list rather than a second kind of list.
function ThreadRow({ thread, language, onRestore, restoringId }: { thread: ThreadListItem; language: "en" | "zh"; onRestore?: (id: string) => void; restoringId: string | null }) {
  const t = copy[language]
  const restoring = restoringId === thread.id
  return <div className="flex min-w-0 items-start gap-1">
    <div className="min-w-0 flex-1"><ThreadLink thread={thread} language={language} /></div>
    {onRestore && <Button type="button" variant="ghost" size="icon-sm" aria-label={t.restoreThread} title={t.restoreThread} disabled={restoring} onClick={() => onRestore(thread.id)}>
      {restoring ? <Spinner /> : <ArchiveRestoreIcon aria-hidden="true" />}
    </Button>}
  </div>
}

export function ThreadList({ threads, loading, language, filters, onFiltersChange, pagination, onCreate, onRestore, restoringId }: {
  threads: ThreadListItem[]
  loading: boolean
  language: "en" | "zh"
  filters: ThreadListFilters
  onFiltersChange: (filters: ThreadListFilters) => void
  pagination: ThreadListPagination
  onCreate: () => void
  onRestore: (id: string) => void
  restoringId: string | null
}) {
  const t = copy[language]
  // Restoring is only offered where archived Threads are listed; every other
  // view lists active Threads and has nothing to restore.
  const archivedView = filters.view === "archived"
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b p-3">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading
        ? <div className="flex flex-col gap-2"><Skeleton className="h-18" /><Skeleton className="h-18" /><Skeleton className="h-18" /></div>
        : <nav aria-label={archivedView ? t.archivedThreads : t.threads} className="flex flex-col gap-1">
          {threads.length === 0 && <ThreadListEmptyState filters={filters} language={language} onReset={() => onFiltersChange(allThreadListFilters)} />}
          {threads.map((thread) => <ThreadRow key={thread.id} thread={thread} language={language} onRestore={archivedView ? onRestore : undefined} restoringId={restoringId} />)}
          <ThreadListMore pagination={pagination} language={language} />
        </nav>}
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
// and the list is never unmounted by a Thread switch. The archived view is the same
// query with one more server parameter, so it inherits paging, polling and caching.
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
    loading: threads.isLoading,
    error: threads.error,
    pagination: { hasMore: threads.hasNextPage, loadingMore: threads.isFetchingNextPage, onLoadMore: () => { void threads.fetchNextPage() } },
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
    <ThreadList threads={list.threads} loading={list.loading} language={language} filters={filters} onFiltersChange={onFiltersChange} pagination={list.pagination} onCreate={onCreate} onRestore={list.onRestore} restoringId={list.restoringId} />
    {failure}
  </>
  return <>
    <div className="pb-2">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} />
    </div>
    <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-12rem)]" aria-label={filters.view === "archived" ? copy[language].archivedThreads : copy[language].threads}>
      {list.loading && <div className="flex flex-col gap-2 px-2 py-1"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>}
      {!list.loading && list.threads.length === 0 && <ThreadListEmptyState filters={filters} language={language} onReset={() => onFiltersChange(allThreadListFilters)} />}
      {!list.loading && list.threads.map((thread) => <ThreadRow key={thread.id} thread={thread} language={language} onRestore={filters.view === "archived" ? list.onRestore : undefined} restoringId={list.restoringId} />)}
      <ThreadListMore pagination={list.pagination} language={language} />
      {failure}
    </nav>
  </>
}
