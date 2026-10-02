import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller"
import { ThreadHistory } from "@/components/thread-history"
import { ThreadStatusBadge } from "@/components/thread-status"
import { ThreadUsagePanel } from "@/components/thread-usage"
import { SharingError, SharingUserId } from "@/components/thread-sharing"
import { pendingResponseRecords } from "@/lib/thread-response"
import { newestRecordId, oldestRecordId, type HistoryRecord } from "@/lib/thread-history"
import { formattedTime } from "@/lib/time"
import { sharedThreadPath, sharedThreadQueryKey, sharingAccessLost, type SharedResponse, type SharedThread, type SharedThreadPageData, type SharingRequest } from "@/lib/thread-sharing"

const copy = {
  en: { title: "Shared with me", mine: "My Threads", hint: "Read-only Threads shared by their owners. Shares are ordered by sharing time; new conversation content remains with the owner.", empty: "No Threads shared with you.", emptyPage: "No accessible shares on this page. Load more to continue.", owner: "Owner", sharedAt: "Shared", readOnly: "Read only", live: "Continuously updated", hide: "Hide from my list", restore: "Restore to my list", hidden: "Hidden shares", active: "Visible shares", more: "Load more", earlier: "Load earlier messages", loading: "Loading shared Thread…", denied: "This Thread is unavailable. Access may have been revoked or the Thread deleted. Previously copied content cannot be recalled.", retry: "Check access again", back: "Back to shared Threads", minimal: "Minimal view (only for me)", noHistory: "No messages yet.", notice: "You can view this conversation, but cannot send messages, control execution or use the owner's devices. Future updates are also visible." },
  zh: { title: "分享给我", mine: "我的 Thread", hint: "由所有者授权查看的只读 Thread，按分享时间排序；会话内容仍保存在所有者账户中。", empty: "还没有分享给你的 Thread。", emptyPage: "本页没有可访问的分享，请加载更多。", owner: "所有者", sharedAt: "分享于", readOnly: "只读", live: "持续更新", hide: "从我的列表隐藏", restore: "恢复到我的列表", hidden: "已隐藏的分享", active: "未隐藏的分享", more: "加载更多", earlier: "加载更早的消息", loading: "正在加载分享的 Thread…", denied: "此 Thread 无法访问，授权可能已撤销或 Thread 已删除。已经复制的内容无法收回。", retry: "重新检查权限", back: "返回分享列表", minimal: "简洁显示（仅影响自己）", noHistory: "还没有消息。", notice: "你可以查看此会话，但不能发送消息、控制执行或使用对方的设备。后续更新也会持续可见。" },
} satisfies Record<"en" | "zh", Record<string, string>>
type BaseProps = { language: "en" | "zh"; sessionId: string | null | undefined; userId: string; request: SharingRequest }

export function SharedThreadsPage(props: BaseProps) {
  return <SharedList key={`${props.sessionId}:${props.userId}`} {...props} />
}
function SharedList({ language, userId, sessionId, request }: BaseProps) {
  const t = copy[language]
  const client = useQueryClient()
  const [hidden, setHidden] = useState(false)
  const key = ["shared-threads", sessionId, userId, hidden]
  const list = useInfiniteQuery({
    queryKey: key, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => request<SharedThreadPageData>(`/api/shared-threads?hidden=${hidden}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, { signal, cache: "no-store" }),
    getNextPageParam: (page) => page.next_cursor ?? undefined, retry: false, refetchInterval: 3000, gcTime: 0,
  })
  const visibility = useMutation({ mutationFn: (item: SharedThread) => request<void>(`/api${sharedThreadPath(item.owner_user_id, item.id)}/visibility`, { method: "PATCH", body: JSON.stringify({ hidden: !hidden }) }), onSuccess: () => client.invalidateQueries({ queryKey: ["shared-threads", sessionId, userId] }) })
  const items = Array.from(new Map((list.data?.pages.flatMap((p) => p.items) ?? []).map((item) => [`${item.owner_user_id}:${item.id}`, item])).values())
  return <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">{t.title}</h1><Link className="text-sm underline" to="/threads">{t.mine}</Link></div>
    <p className="text-sm text-muted-foreground">{t.hint}</p><SharingUserId userId={userId} language={language} />
    <Button className="self-start" variant="outline" onClick={() => setHidden(!hidden)}>{hidden ? t.active : t.hidden}</Button>
    {list.error ? <SharingError error={list.error} language={language} retry={() => void list.refetch()} /> : <>
      {list.isPending && <Spinner />}{!list.isPending && items.length === 0 && <p className="text-sm text-muted-foreground">{list.hasNextPage ? t.emptyPage : t.empty}</p>}
      <ul className="divide-y rounded-xl border">{items.map((item) => <li key={`${item.owner_user_id}:${item.id}`} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-0 flex-1 basis-48"><Link className="block break-words text-sm font-medium hover:underline" to={sharedThreadPath(item.owner_user_id, item.id)}>{item.title}</Link><p className="mt-1 break-all text-xs text-muted-foreground">{t.owner}: {item.owner_user_id}</p><p className="mt-1 text-xs text-muted-foreground">{t.sharedAt} {formattedTime(language, item.shared_at)}</p></div><ThreadStatusBadge language={language} status={item.display_status} /><Badge variant="outline">{t.readOnly}</Badge><Button size="sm" variant="ghost" disabled={visibility.isPending} onClick={() => visibility.mutate(item)}>{hidden ? t.restore : t.hide}</Button></li>)}</ul>
    </>}
    {visibility.error && <SharingError error={visibility.error} language={language} />}
    {list.hasNextPage && <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage && <Spinner />}{t.more}</Button>}
  </main>
}

type ReaderProps = BaseProps & { ownerId: string; threadId: string; renderRecord: (record: HistoryRecord) => ReactNode }
export function SharedThreadPage(props: ReaderProps) {
  return <SharedSession key={JSON.stringify([props.sessionId, props.userId, props.ownerId, props.threadId])} {...props} />
}
function SharedSession(props: ReaderProps) {
  const [lost, setLost] = useState(false)
  const onLost = useCallback(() => setLost(true), [])
  const t = copy[props.language]
  if (lost) return <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4"><Alert><AlertDescription>{t.denied}</AlertDescription></Alert><Button className="self-start" onClick={() => setLost(false)}>{t.retry}</Button><Link className="text-sm underline" to="/shared-threads">{t.back}</Link></main>
  return <SharedReader {...props} onLost={onLost} />
}
function SharedReader({ language, userId, sessionId, ownerId, threadId, request, renderRecord, onLost }: ReaderProps & { onLost: () => void }) {
  const t = copy[language]
  const client = useQueryClient()
  const scope = useMemo(() => sharedThreadQueryKey(sessionId, userId, ownerId, threadId), [sessionId, userId, ownerId, threadId])
  const path = `/api${sharedThreadPath(ownerId, threadId)}`
  const checked: SharingRequest = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    try { return await request<T>(url, { ...init, cache: "no-store" }) }
    catch (error) { if (sharingAccessLost(error)) onLost(); throw error }
  }, [request, onLost])
  const detail = useQuery({ queryKey: [...scope, "detail"], queryFn: ({ signal }) => checked<SharedThread>(path, { signal }), retry: false, refetchInterval: 1500, refetchIntervalInBackground: true, gcTime: 0 })
  // Revocation unmounts this entire reader. Abort in-flight pages/previews before
  // removing every cache entry, so late responses cannot repopulate the view.
  useEffect(() => () => { void client.cancelQueries({ queryKey: scope }); client.removeQueries({ queryKey: scope }) }, [client, scope])
  if (detail.error) return <div className="p-4"><SharingError error={detail.error} language={language} retry={() => void detail.refetch()} /></div>
  if (!detail.data) return <p role="status" className="p-4 text-sm text-muted-foreground">{t.loading}</p>
  return <SharedConversation key={detail.data.grant_id} thread={detail.data} scope={scope} path={path} language={language} request={checked} renderRecord={renderRecord} />
}

type Window = { records: HistoryRecord[]; has_older: boolean }
type Content = Window & { response: SharedResponse | null }
function SharedConversation({ thread, scope, path, language, request, renderRecord }: { thread: SharedThread; scope: readonly unknown[]; path: string; language: "en" | "zh"; request: SharingRequest; renderRecord: (record: HistoryRecord) => ReactNode }) {
  const t = copy[language]
  const client = useQueryClient()
  const [minimal, setMinimal] = useState(false)
  const key = [...scope, thread.grant_id, "content"]
  const content = useQuery({ queryKey: key, queryFn: async ({ signal }) => {
    const previous = client.getQueryData<Content>(key)
    const window = previous
      ? { ...previous, records: [...previous.records, ...await request<HistoryRecord[]>(`${path}/history?after=${newestRecordId(previous.records)}`, { signal })] }
      : await request<Window>(`${path}/history/window`, { signal })
    const response = thread.status === "running" ? await request<SharedResponse | null>(`${path}/response`, { signal }) : null
    return { ...window, response }
  }, retry: false, refetchInterval: 1200, refetchIntervalInBackground: true, gcTime: 0 })
  const older = useInfiniteQuery({ queryKey: [...scope, thread.grant_id, "older"], enabled: false,
    initialPageParam: oldestRecordId(content.data?.records ?? []),
    queryFn: ({ pageParam, signal }) => request<Window>(`${path}/history/window?before=${pageParam}`, { signal }),
    getNextPageParam: (page) => page.has_older ? oldestRecordId(page.records) ?? undefined : undefined,
    retry: false, gcTime: 0,
  })
  const records = useMemo(() => [...(older.data?.pages ?? []).slice().reverse().flatMap((p) => p.records), ...(content.data?.records ?? [])], [older.data, content.data])
  const pending = pendingResponseRecords(content.data?.response, records, thread.id)
  const hasOlder = older.data?.pages.at(-1)?.has_older ?? content.data?.has_older ?? false
  return <main className="flex h-[calc(100svh-3.5rem)] min-w-0 flex-col">
    <header className="flex shrink-0 flex-col gap-2 border-b p-4"><Link className="self-start text-xs underline" to="/shared-threads">{t.back}</Link><h1 className="break-words text-base font-semibold">{thread.title}</h1><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{t.readOnly}</Badge><span className="text-xs text-muted-foreground">{t.live}</span><ThreadStatusBadge language={language} status={thread.display_status} /></div><p className="break-all text-xs text-muted-foreground">{t.owner}: {thread.owner_user_id}</p><p className="text-xs text-muted-foreground">{t.notice}</p><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={minimal} onChange={(event) => setMinimal(event.target.checked)} />{t.minimal}</label></header>
    <ThreadUsagePanel usage={thread.usage} language={language} />
    {content.error ? <div className="p-4"><SharingError error={content.error} language={language} retry={() => void content.refetch()} /></div> : <MessageScrollerProvider autoScroll defaultScrollPosition="end"><MessageScroller className="min-h-0 flex-1">
      {hasOlder && <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-6"><Button className="pointer-events-auto shadow-sm" size="sm" variant="outline" disabled={older.isFetching} onClick={() => { if (older.data) void older.fetchNextPage(); else void older.refetch() }}>{older.isFetching && <Spinner />}{t.earlier}</Button></div>}
      <MessageScrollerViewport><MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
        {content.isPending && <p role="status">{t.loading}</p>}{older.error && <SharingError error={older.error} language={language} retry={() => { if (older.data) void older.fetchNextPage(); else void older.refetch() }} />}
        <ThreadHistory records={[...records, ...pending]} language={language} minimal={minimal} renderRecord={renderRecord} />
        {!content.isPending && records.length === 0 && pending.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t.noHistory}</p>}
      </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" />
    </MessageScroller></MessageScrollerProvider>}
  </main>
}
