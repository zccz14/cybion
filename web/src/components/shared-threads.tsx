import { useCallback, useMemo, useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { LinkitUserInfo } from "linkit-react-components"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CybionThreadProvider, CybionThreadView, type CybionThreadSource, type CybionThreadSummary, type ThreadResponseView } from "@zccz14/cybion-components"
import type { HistoryRecord } from "@zccz14/cybion-components"
import { sharedThreadApiPath, sharedThreadQueryKey, sharingAccessLost, type SharedResponse, type SharedThread, type SharingRequest } from "@/lib/thread-sharing"

/**
 * A Thread somebody else owns, read live.
 *
 * The reader is the ordinary conversation view with a source instead of this account's
 * Thread store: the package already knows how to page history, render records, follow a
 * running turn and drop its cache when permission ends, so sharing adds no second
 * renderer — only the place the four reads come from, and the three things a reader
 * legitimately sees about the owner.
 */
export type SharedThreadReaderProps = {
  language: "en" | "zh"
  sessionId: string | null | undefined
  userId: string
  ownerId: string
  threadId: string
  baseUrl: string
  getToken: () => string | Promise<string>
  request: SharingRequest
  /** Resolve recorded audio; the owner's object store is not this account's. */
  loadAudio: (reference: string, mediaType: string | null) => Promise<string>
  /** The host's cache, so a reader shares the app's one query client. */
  queryClient?: QueryClient
}

const copy = {
  en: {
    back: "Back to Threads", owner: "Owner", readOnly: "Read only", live: "Continuously updated",
    notice: "You can read this conversation, but cannot send messages, control execution or use the owner's devices. Future updates stay visible.",
    minimal: "Minimal view (only for me)", denied: "This Thread is unavailable. Access may have been revoked or the Thread deleted. Previously copied content cannot be recalled.",
  },
  zh: {
    back: "返回对话线程", owner: "所有者", readOnly: "只读", live: "持续更新",
    notice: "你可以查看此会话，但不能发送消息、控制执行或使用对方的设备。后续更新也会持续可见。",
    minimal: "简洁显示（仅影响自己）", denied: "此 Thread 无法访问。授权可能已撤销，或 Thread 已被删除；已经复制的内容无法收回。",
  },
} satisfies Record<"en" | "zh", Record<string, string>>

export function SharedThreadPage({ language, sessionId, userId, ownerId, threadId, baseUrl, getToken, request, loadAudio, queryClient }: SharedThreadReaderProps) {
  return <CybionThreadProvider queryClient={queryClient} baseUrl={baseUrl} getToken={getToken} sessionId={sessionId ?? userId} identity={userId} language={language}>
    <SharedThreadReader key={`${sessionId}:${userId}:${ownerId}:${threadId}`} language={language} sessionId={sessionId} userId={userId} ownerId={ownerId} threadId={threadId} request={request} loadAudio={loadAudio} />
  </CybionThreadProvider>
}

function SharedThreadReader({ language, sessionId, userId, ownerId, threadId, request, loadAudio }: Omit<SharedThreadReaderProps, "baseUrl" | "getToken" | "queryClient">) {
  const t = copy[language]
  // Minimal is the reader's own preference and cannot travel: the summary carries no
  // settings, so it lives here instead of being written back to the owner's Thread.
  const [minimal, setMinimal] = useState(false)
  const client = useQueryClient()
  const source = useMemo<CybionThreadSource>(() => {
    const path = sharedThreadApiPath(ownerId, threadId)
    const scope = sharedThreadQueryKey(sessionId, userId, ownerId, threadId)
    return {
      scope,
      read: async () => summarize(await request<SharedThread>(path)),
      historyWindow: async (before?: number) => {
        const page = await request<{ records: HistoryRecord[]; has_older: boolean }>(`${path}/history/window${before === undefined ? "" : `?before=${before}`}`)
        return { records: page.records, hasOlder: page.has_older }
      },
      history: (after: number) => request<HistoryRecord[]>(`${path}/history?after=${after}`),
      // The shared projection carries the lifecycle and the output a reader may see,
      // not the audit identifiers the owner's own view shows; the reader renders
      // `pendingResponseRecords`, which reads only the fields that are here.
      response: async () => await request<SharedResponse | null>(`${path}/response`) as ThreadResponseView | null,
      accessLost: sharingAccessLost,
      // The reader keeps no copy of a Thread it may no longer read: the package asks the
      // cache to drop the scope, and this releases whatever the router left behind.
      onAccessLost: () => { void client.cancelQueries({ queryKey: [...scope] }); client.removeQueries({ queryKey: [...scope] }) },
    }
  }, [client, ownerId, request, sessionId, threadId, userId])
  return <CybionThreadView
    threadId={threadId}
    source={source}
    minimal={minimal}
    loadAudio={loadAudio}
    headerBreadcrumb={<span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Link className="shrink-0 underline" to={{ pathname: "/threads", search: "?view=shared" }}>{t.back}</Link>
      <span className="shrink-0">{t.owner}</span>
      <LinkitUserInfo userId={ownerId} compact />
      <span className="shrink-0">{t.live}</span>
    </span>}
    headerActions={<>
      <Badge variant="outline">{t.readOnly}</Badge>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t.minimal} title={t.minimal} aria-pressed={minimal} onClick={() => setMinimal((value) => !value)}>
        {minimal ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </>}
    transcriptFooter={<p className="border-t pt-3 text-xs text-muted-foreground">{t.notice}</p>}
    readOnly
  />
}

/** The summary is the share's own allowlist; nothing the owner's settings carry crosses. */
function summarize(thread: SharedThread): CybionThreadSummary {
  return {
    id: thread.id, title: thread.title, status: thread.status, display_status: thread.display_status,
    running_summary: thread.running_summary, usage: thread.usage,
  }
}
