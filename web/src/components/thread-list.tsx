import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArchiveRestoreIcon, EyeIcon, EyeOffIcon } from "lucide-react"
import type { ReactNode } from "react"
import { LinkitUserInfo } from "linkit-react-components"
import { ThreadLink } from "@/components/thread-status"
import { ThreadListControls, ThreadListEmptyState, ThreadListMore, type ThreadListPagination } from "@/components/thread-list-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@zccz14/cybion-components/internal"
import { allThreadListFilters, isSharedThreadListView, mergeThreadPages, sharedThreadsUrl, threadListUrl, type ThreadListFilters } from "@/lib/thread-search"
import { sharedThreadApiPath, sharedThreadPath, type SharedThread, type SharedThreadPageData } from "@/lib/thread-sharing"
import type { ThreadDisplayStatus } from "@zccz14/cybion-components/internal"
import type { ThreadUsage } from "@zccz14/cybion-components/internal"

export type ThreadListItem = {
  created_by: "web" | "api"
  external_ref: string | null
  id: string
  title: string
  display_status: ThreadDisplayStatus
  running_summary: string | null
  updated_at: number
  usage: ThreadUsage
  branches: number
}

type ThreadPage = { items: ThreadListItem[]; next_cursor: string | null; total: number }

/** What a row needs from whichever source listed it. */
export type ThreadListRow = {
  /** Unique inside one list: a shared Thread keeps its own id under each owner. */
  key: string
  thread: ThreadListItem
  /** Where the row points; a share points at the owner's Thread. */
  to: string
  /** Extra qualifier on the title line — the owner of a shared Thread. */
  badge?: ReactNode
  /** The one list action that belongs to this row, if any. */
  action?: { label: ThreadListAction; icon: ReactNode; pending: boolean; run: () => void }
}

type ThreadListAction = "restore" | "hide"

/** The one toggle the shared category adds to the control bar. */
export type ThreadListHiddenShares = { active: boolean; onToggle: () => void }

type ThreadListCopyKey = "threads" | "archivedThreads" | "sharedThreads" | "restore" | "hide"

const copy = {
  en: { threads: "Threads", archivedThreads: "Archived", sharedThreads: "Shared with me", restore: "Restore", hide: "Hide from my list" },
  zh: { threads: "对话线程", archivedThreads: "已归档", sharedThreads: "分享给我", restore: "恢复", hide: "从我的列表隐藏" },
} satisfies Record<"en" | "zh", Record<ThreadListCopyKey, string>>

// One row, whatever listed it. An archived Thread and a shared one both keep the row
// shape every other row has and add the single action that belongs to them, so every
// category reads as the same list rather than a second kind of list.
function ThreadRow({ row, language }: { row: ThreadListRow; language: "en" | "zh" }) {
  const action = row.action
  return <div className="flex min-w-0 items-start gap-1">
    <div className="min-w-0 flex-1"><ThreadLink thread={row.thread} language={language} to={row.to} badge={row.badge} /></div>
    {action && <Button type="button" variant="ghost" size="icon-sm" aria-label={copy[language][action.label]} title={copy[language][action.label]} disabled={action.pending} onClick={action.run}>
      {action.pending ? <Spinner /> : action.icon}
    </Button>}
  </div>
}

export function ThreadList({ rows, loading, language, filters, onFiltersChange, pagination, onCreate, blockedThreads, hiddenShares }: {
  rows: ThreadListRow[]
  loading: boolean
  language: "en" | "zh"
  filters: ThreadListFilters
  onFiltersChange: (filters: ThreadListFilters) => void
  pagination: ThreadListPagination
  onCreate: () => void
  blockedThreads?: number
  /** The hidden half of the shared category is one toggle away. */
  hiddenShares?: ThreadListHiddenShares
}) {
  const t = copy[language]
  const shared = isSharedThreadListView(filters.view)
  const label = filters.view === "archived" ? t.archivedThreads : shared ? t.sharedThreads : t.threads
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b p-3">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} blockedThreads={blockedThreads} hiddenShares={hiddenShares} />
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading
        ? <div className="flex flex-col gap-2"><Skeleton className="h-18" /><Skeleton className="h-18" /><Skeleton className="h-18" /></div>
        : <nav aria-label={label} className="flex flex-col gap-1">
          {rows.length === 0 && <ThreadListEmptyState filters={filters} language={language} hasMore={pagination.hasMore} onReset={() => onFiltersChange(allThreadListFilters)} />}
          {rows.map((row) => <ThreadRow key={row.key} row={row} language={language} />)}
          <ThreadListMore pagination={pagination} language={language} />
        </nav>}
    </div>
  </div>
}

export type ThreadListRequest = <T>(path: string, init?: RequestInit) => Promise<T>

// The list polls itself: titles, statuses and usage written by any origin — the
// browser, the integration API, a Worker turn still running — arrive within one
// interval, and every screen that shows the list shows the same fresh rows.
const threadListPollMs = 2000
// Shares are discovered on the recipient's side, so they arrive one propagation later
// than an owned row and one interval is enough to see it.
const sharedListPollMs = 3000

// The one number the list shows about Threads it may not be listing: how many are
// waiting on the user. It polls on the same cadence and reads the same server total
// the blocked view itself would page through, so the chip and the view cannot disagree.
function useBlockedThreadCount({ sessionId, request, enabled }: { sessionId: string | null | undefined; request: ThreadListRequest; enabled: boolean }) {
  const blocked = useQuery({
    queryKey: ["threads", sessionId, "blocked-count"],
    queryFn: () => request<ThreadPage>("/api/threads?blocked=true&limit=1"),
    refetchInterval: threadListPollMs,
    staleTime: threadListPollMs,
    enabled,
  })
  return blocked.data?.total
}

function listRow(thread: ThreadListItem): ThreadListRow {
  return { key: thread.id, thread, to: `/threads/${thread.id}` }
}
function sharedRow(item: SharedThread): ThreadListRow {
  return {
    key: `${item.owner_user_id}:${item.id}`,
    thread: { ...item, created_by: "web", external_ref: null, branches: 0 },
    to: sharedThreadPath(item.owner_user_id, item.id),
    badge: <LinkitUserInfo userId={item.owner_user_id} compact />,
  }
}

// INVARIANT: the Thread List owns the threads. No page, shell or conversation above
// it fetches, holds or polls thread rows, so opening a Thread cannot refetch the list,
// and the list is never unmounted by a Thread switch. Sharing is one category of the
// same list, so it inherits paging, polling, the row shape and the empty state; only the
// endpoint and the one action a shared row carries differ.
function useThreadList({ sessionId, request, filters }: { sessionId: string | null | undefined; request: ThreadListRequest; filters: ThreadListFilters }) {
  const client = useQueryClient()
  const shared = isSharedThreadListView(filters.view)
  const owned = useInfiniteQuery({
    queryKey: ["threads", sessionId, threadListUrl(filters)],
    queryFn: ({ pageParam }) => request<ThreadPage>(threadListUrl(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: threadListPollMs,
    // One polling window is already fresh, so a list that remounts inside it reads the
    // cache instead of asking the server for rows it would have polled a moment later.
    staleTime: threadListPollMs,
    // Switching category keeps the previous rows on screen instead of blanking the list
    // while the next page set arrives.
    placeholderData: keepPreviousData,
    enabled: !shared,
  })
  const shares = useInfiniteQuery({
    queryKey: ["shared-threads", sessionId, filters.hidden],
    queryFn: ({ pageParam, signal }) => request<SharedThreadPageData>(sharedThreadsUrl(filters.hidden, pageParam), { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    refetchInterval: sharedListPollMs,
    staleTime: sharedListPollMs,
    enabled: shared,
  })
  // Both list actions are one list action: a row that was put away comes back. Restoring
  // an archived Thread writes its owner's row; restoring a share writes this account's
  // local visibility. Each invalidates the list it belongs to.
  const restore = useMutation({
    mutationFn: (threadId: string) => request<{ id: string }>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ archived: false }) }),
    onSuccess: (thread) => {
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["thread", thread.id] })
    },
  })
  const visibility = useMutation({
    mutationFn: (item: SharedThread) => request<void>(`${sharedThreadApiPath(item.owner_user_id, item.id)}/visibility`, { method: "PATCH", body: JSON.stringify({ hidden: !filters.hidden }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["shared-threads"] })
    },
  })
  const restoreAction = (thread: ThreadListItem): ThreadListRow["action"] => ({
    label: "restore",
    icon: <ArchiveRestoreIcon aria-hidden="true" />,
    pending: restore.isPending && restore.variables === thread.id,
    run: () => restore.mutate(thread.id),
  })
  // A shared row carries the share's own one action: putting it aside or taking it back.
  const shareAction = (item: SharedThread): ThreadListRow["action"] => ({
    label: filters.hidden ? "restore" : "hide",
    icon: filters.hidden ? <ArchiveRestoreIcon aria-hidden="true" /> : <EyeOffIcon aria-hidden="true" />,
    pending: visibility.isPending && visibility.variables?.id === item.id,
    run: () => visibility.mutate(item),
  })
  const rows: ThreadListRow[] = shared
    ? mergeThreadPages(shares.data?.pages.map((page) => page.items) ?? [], (item) => `${item.owner_user_id}:${item.id}`)
      .map((item) => ({ ...sharedRow(item), action: shareAction(item) }))
    : mergeThreadPages(owned.data?.pages.map((page) => page.items) ?? [], (thread) => thread.id)
      .map((thread) => ({ ...listRow(thread), action: filters.view === "archived" ? restoreAction(thread) : undefined }))
  return {
    rows,
    loading: (shared ? shares : owned).isLoading,
    error: (shared ? shares : owned).error,
    pagination: {
      hasMore: (shared ? shares : owned).hasNextPage,
      loadingMore: (shared ? shares : owned).isFetchingNextPage,
      onLoadMore: () => { void (shared ? shares : owned).fetchNextPage() },
    },
    // Which half of the shared category is on screen; the control bar owns the wording.
    hidden: shared ? filters.hidden : null,
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
  const blockedThreads = useBlockedThreadCount({ sessionId, request, enabled: !isSharedThreadListView(filters.view) })
  const failure = Boolean(list.error) && <p className="px-3 py-2 text-xs text-destructive">{errorMessage(list.error)}</p>
  // Which half of the shared category is on screen. Hiding is one recipient's own
  // choice about somebody else's Thread, so it is a toggle inside that category rather
  // than a category of its own — the filter value carries it, the URL keeps it.
  const hiddenShares: ThreadListHiddenShares | undefined = isSharedThreadListView(filters.view)
    ? { active: filters.hidden, onToggle: () => onFiltersChange({ ...filters, hidden: !filters.hidden }) }
    : undefined
  if (layout === "page") return <>
    <ThreadList rows={list.rows} loading={list.loading} language={language} filters={filters} onFiltersChange={onFiltersChange} pagination={list.pagination} onCreate={onCreate} blockedThreads={blockedThreads} hiddenShares={hiddenShares} />
    {failure}
  </>
  return <>
    <div className="pb-2">
      <ThreadListControls filters={filters} language={language} onFiltersChange={onFiltersChange} onNewThread={onCreate} blockedThreads={blockedThreads} hiddenShares={hiddenShares} />
    </div>
    <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-12rem)]" aria-label={filters.view === "archived" ? copy[language].archivedThreads : copy[language].threads}>
      {list.loading && <div className="flex flex-col gap-2 px-2 py-1"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>}
      {!list.loading && list.rows.length === 0 && <ThreadListEmptyState filters={filters} language={language} hasMore={list.pagination.hasMore} onReset={() => onFiltersChange(allThreadListFilters)} />}
      {!list.loading && list.rows.map((row) => <ThreadRow key={row.key} row={row} language={language} />)}
      <ThreadListMore pagination={list.pagination} language={language} />
      {failure}
    </nav>
  </>
}
