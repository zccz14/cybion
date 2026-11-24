import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  CircleAlertIcon, CheckIcon, Minimize2Icon, PencilIcon, PlayIcon, SendIcon, SparklesIcon, SquareIcon,
} from "lucide-react"

import { Markdown } from "@zccz14/ux"

import type { Language, Thread, ThreadDefaults, RequestAck } from "./api"
import { useCybion } from "./provider"
import { HistoryMessage, type ManualSummary, type Worker } from "./components/history-message"
import { ThreadHistory } from "./components/thread-history"
import { ThreadSettingsButton } from "./components/thread-settings-button"
import { ThreadContextUsage, ThreadUsagePanel } from "./components/thread-usage"
import { ThreadStatusBadge, ThreadStatusSummary } from "./components/thread-status"
import { ComposerAttach } from "./components/composer-attach"
import { ComposerAttachments } from "./components/composer-attachments"
import { ComposerAudio } from "./components/composer-audio"
import { ComposerFileNotice, ComposerLengthNotice } from "./components/composer-file-notice"
import { ComposerAudioNotice } from "./components/composer-audio-notice"
import { ComposerDraftNotice } from "./components/composer-draft-notice"
import { useComposerAttach } from "./hooks/use-composer-attach"
import { useComposerAudio } from "./hooks/use-composer-audio"
import { audioDraftScope } from "./lib/composer-audio-drafts"
import { useComposerDraft } from "./hooks/use-composer-draft"
import { useComposerFiles } from "./hooks/use-composer-files"
import { useComposerImages } from "./hooks/use-composer-images"
import { composeComposerInput, maxInputChars } from "./lib/composer-files"
import { composerAction, handleChatInputKeyDown } from "./lib/chat-input"
import { pollThreadHistory, oldestRecordId, recordInFlight, inFlightCallIds, loadedThreadRecords, type HistoryRecord, type ThreadHistoryWindow } from "./lib/thread-history"
import { pendingResponseRecords, type ThreadResponseView } from "./lib/thread-response"
import { newestBudgetRecordId } from "./lib/budget-stop"
import { Alert, AlertDescription, AlertTitle } from "./ui/alert"
import { Button } from "./ui/button"
import { Badge } from "./ui/badge"
import { Field, FieldGroup, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./ui/message-scroller"
import { Message, MessageContent, MessageFooter } from "./ui/message"
import { Spinner } from "./ui/spinner"
import { Textarea } from "./ui/textarea"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Skeleton } from "./ui/skeleton"
import { errorMessage } from "./lib/utils"
import { threadRootClass } from "./lib/thread-root"

export type CybionThreadViewProps = {
  /** The only required input: the thread to show. */
  threadId: string
  /** Extra classes on the view's root. The default minimum height is the
   * full-page shell; an embedder that gives the view its own box passes
   * `min-h-0` and takes over. */
  className?: string
  /** Called whenever the stored title changes, so a host can mirror it. */
  onTitleChange?: (title: string) => void
  /** Called after every thread read, for chrome the view does not own (archive state, sharing). */
  onThreadChange?: (thread: Thread) => void
  /** Device and Manual names the record cards resolve; absent cards show raw ids. */
  workers?: Worker[]
  manuals?: ReadonlyMap<string, ManualSummary>
  /** Resolve recorded audio; defaults to the object store behind the same token. */
  loadAudio?: (reference: string, mediaType: string | null) => Promise<string>
  /** Replace the default record renderer entirely; the context carries the in-flight flag. */
  renderRecord?: (record: HistoryRecord, context: { inFlight: boolean }) => ReactNode
  /** Host buttons that belong beside the title, e.g. share, archive, delete. */
  headerActions?: ReactNode
  /** Rendered before the title; the mobile back button lives here. */
  headerLeading?: ReactNode
  /** Rendered above the title, e.g. the link back to the Thread this one was
   * subcontracted from. */
  headerBreadcrumb?: ReactNode
  /** Host panels that belong under the transcript, e.g. open notes or loaded manuals. */
  transcriptFooter?: ReactNode
  /** Host retains older pages across route changes, as the original shell did. */
  olderPages?: ThreadHistoryWindow[]
  onOlderPage?: (threadId: string, page: ThreadHistoryWindow) => void
  onRecordsChange?: (records: HistoryRecord[]) => void
  /** Renders a Thread the host does not own: every read comes from `source`
   * instead of this account's own Thread store, and nothing is ever written. */
  source?: CybionThreadSource
  /** Overrides the stored display preference, for a reader whose own copy is
   * local (a shared Thread cannot carry the owner's setting). */
  minimal?: boolean
  readOnly?: boolean
}

/**
 * What the view shows about the Thread it renders. An owned Thread is the whole
 * `Thread`; a Thread read through a `CybionThreadSource` carries only what any
 * reader may see, so the fields a source cannot vouch for stay optional instead
 * of being invented.
 */
export type CybionThreadSummary = Pick<Thread, "id" | "title" | "status" | "display_status" | "running_summary" | "usage"> &
  Partial<Pick<Thread, "created_by" | "external_ref" | "archived_at" | "context_tokens" | "context_budget_tokens" | "minimal_mode">>

/**
 * A Thread the viewer does not own. The source owns every read of it — the
 * metadata, the transcript windows, the live preview — so the view keeps one
 * code path and the host decides where permission comes from. `scope` separates
 * cache entries by data space: the same Thread read by two viewers, or by its
 * owner, never shares one. `accessLost` marks the failures that end the view
 * instead of being retried.
 */
export type CybionThreadSource = {
  scope: readonly unknown[]
  read: () => Promise<CybionThreadSummary>
  historyWindow: (before?: number) => Promise<ThreadHistoryWindow>
  history: (after: number) => Promise<HistoryRecord[]>
  response: () => Promise<ThreadResponseView | null>
  accessLost?: (error: unknown) => boolean
  onAccessLost?: () => void
}

/** Pure extraction of the pre-#697 conversation. Queries stay independent and
 * share the host cache; slots only replace host-owned navigation and panels. */
export function CybionThreadView(props: CybionThreadViewProps) {
  const { identity } = useCybion()
  // The old route keyed the whole conversation. Embedders get the same reset
  // when changing the ID without having to know about its local draft/voice state.
  return <ThreadConversation key={`${identity}:${props.threadId}`} {...props} />
}

function ThreadConversation({ threadId, className, onTitleChange, onThreadChange, onRecordsChange, workers, manuals, loadAudio: loadAudioOverride, renderRecord, headerActions, headerLeading, headerBreadcrumb, transcriptFooter, olderPages: hostOlderPages, onOlderPage, source, minimal: minimalOverride, readOnly = false }: CybionThreadViewProps) {
  const { client: transport, language, identity: userId, sessionId, t } = useCybion()
  const client = useQueryClient()
  // A Thread read through a source belongs to someone else by definition, so the source
  // and `readOnly` are one gate: nothing in the view writes while either is on.
  const writable = !source && !readOnly
  // A refused read ends the view: the queries are switched off, so a reader cannot keep
  // polling a Thread it may no longer see, and in-flight pages are dropped by the effect
  // below instead of landing in the cache. Asking to recheck turns them back on, which is
  // how a regranted Thread comes back without a reload.
  const [halted, setHalted] = useState(false)
  // The refusal is latched, not read from the last error: the cache it wipes takes that
  // error with it, and a refused Thread must keep saying so until the reader rechecks.
  const [denied, setDenied] = useState(false)
  const cachedOlderPages = useQuery<ThreadHistoryWindow[]>({ queryKey: ["history-older", threadId, userId], initialData: [], enabled: false })
  const olderPages = hostOlderPages ?? cachedOlderPages.data
  const rememberOlderPage = (id: string, page: ThreadHistoryWindow) => {
    if (onOlderPage) onOlderPage(id, page)
    else client.setQueryData<ThreadHistoryWindow[]>(["history-older", id, userId], (pages) => [page, ...(pages ?? [])])
  }
  // The list already holds this Thread's row — the server sends whole Threads, not summaries —
  // so the header and the composer render from it while the detail read is still in flight, and
  // only the transcript waits.
  const listedThread = useCallback(() => client
    .getQueriesData<{ items: Thread[] }>({ queryKey: ["threads", sessionId] })
    .flatMap(([, page]) => page?.items ?? [])
    .find((item) => item.id === threadId), [client, sessionId, threadId])
  // One read path, two data spaces: an owned Thread comes from this account's store, a
  // Thread read through a source comes from whoever authorized it. The source's scope is
  // part of the key, so no cached owner content can ever be shown to a reader.
  const thread = useQuery<Thread | CybionThreadSummary>({
    queryKey: source ? [...source.scope, "thread", threadId] : ["thread", threadId, userId],
    queryFn: source ? source.read : () => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
    placeholderData: source ? undefined : listedThread,
    refetchInterval: 1500,
    enabled: Boolean(threadId) && !halted,
  })
  // A source already carries the settings a reader may see, so the account defaults are
  // never read for it: they belong to the viewer, not to the Thread being read.
  const defaults = useQuery({ queryKey: ["thread-defaults"], queryFn: ({ signal }) => transport.request<ThreadDefaults>("/api/thread-defaults", { signal }), enabled: !source })
  // The conversation opens on the window that starts at the most recent user input instead of
  // the whole thread; older pages load on demand, each one a whole turn that starts at the
  // previous input record, until `has_older` clears.
  const fetchHistoryWindow = source
    ? source.historyWindow
    : (before?: number) => transport.request<{ records: HistoryRecord[]; has_older: boolean }>(
      `/api/threads/${encodeURIComponent(threadId)}/history/window${before === undefined ? "" : `?before=${before}`}`,
    ).then((page) => ({ records: page.records, hasOlder: page.has_older }))
  const historyKey = source ? [...source.scope, "history", threadId] : ["history", threadId, userId]
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => pollThreadHistory(
      client.getQueryData<ThreadHistoryWindow>(historyKey),
      () => fetchHistoryWindow(),
      source ? source.history : (after) => transport.request<HistoryRecord[]>(`/api/threads/${encodeURIComponent(threadId)}/history?after=${after}`),
    ),
    refetchInterval: thread.data?.status === "running" ? 1200 : 2500,
    // A source's transcript opens only after its own metadata read proved the reader may
    // see this Thread, so a refused link never asks for a transcript or a live preview.
    enabled: Boolean(threadId) && !halted && (!source || thread.data !== undefined),
  })
  const liveResponse = useQuery({
    queryKey: source
      ? [...source.scope, "response", threadId, thread.data?.status]
      : ["thread-response", threadId, thread.data?.status, userId],
    queryFn: source ? source.response : () => transport.request<ThreadResponseView | null>(`/api/threads/${encodeURIComponent(threadId)}/response`),
    refetchInterval: thread.data?.status === "running" ? 750 : false,
    enabled: Boolean(threadId) && !halted && (!source || thread.data !== undefined),
  })
  const durableRecords = useMemo(() => loadedThreadRecords(olderPages, history.data), [olderPages, history.data])
  const records = useMemo(() => [
    ...durableRecords,
    ...pendingResponseRecords(liveResponse.data, durableRecords, threadId),
  ], [durableRecords, liveResponse.data, threadId])
  const hasOlder = olderPages[0]?.hasOlder ?? history.data?.hasOlder ?? false
  const loadEarlier = useMutation({
    mutationFn: async () => {
      const before = oldestRecordId(durableRecords)
      if (before === null) return null
      return { threadId, page: await fetchHistoryWindow(before) }
    },
    onSuccess: (loaded) => {
      if (loaded) rememberOlderPage(loaded.threadId, loaded.page)
    },
  })
  const composer = useComposerDraft(userId, threadId)
  const { input, setInput, clearSubmitted } = composer
  const attachments = useComposerImages()
  const audio = useComposerAudio({ scope: audioDraftScope(userId, threadId) })
  const files = useComposerFiles()
  const attach = useComposerAttach({ images: attachments, audio, files })
  const loadAudio = loadAudioOverride ?? transport.audioObjectUrl
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  useEffect(() => {
    setTitle(thread.data?.title ?? "")
    setEditing(false)
  }, [threadId, thread.data?.title])
  const submit = useMutation({
    // `draft` is the typed text and `input` what actually travels (draft plus the
    // text of every attachment), so the draft that clears is the one the user sees.
    mutationFn: (value: { draft: string; input: string; images: string[]; audios: string[] }) => transport.request<RequestAck>(`/api/threads/${encodeURIComponent(threadId)}/inputs`, {
      method: "POST",
      body: JSON.stringify({ input: value.input, images: value.images, audios: value.audios }),
    }),
    onSuccess: (_request, submitted) => {
      clearSubmitted(submitted.draft)
      attachments.clear()
      audio.clear()
      files.clear()
      void client.invalidateQueries({ queryKey: ["history", threadId] })
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["reasoning-audits"] })
    },
  })
  const control = useMutation({
    mutationFn: (action: "cancel" | "continue" | "compact") => transport.request<unknown>(`/api/threads/${encodeURIComponent(threadId)}/${action}`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["history", threadId] }),
        client.invalidateQueries({ queryKey: ["thread", threadId] }),
        client.invalidateQueries({ queryKey: ["thread-response", threadId] }),
        client.invalidateQueries({ queryKey: ["threads"] }),
        client.invalidateQueries({ queryKey: ["reasoning-audits"] }),
        client.invalidateQueries({ queryKey: ["worker-calls", sessionId] }),
      ])
    },
  })
  const rename = useMutation({
    mutationFn: (nextTitle: string) => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: nextTitle }),
    }),
    onSuccess: () => {
      setEditing(false)
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const generateTitle = useMutation({
    mutationFn: () => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}/title`, { method: "POST" }),
    onSuccess: (thread: Thread) => {
      setTitle(thread.title)
      setEditing(false)
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["reasoning-audits"] })
    },
  })
  // Adding budget is two calls the user asked for with one click: raise the limit
  // to the settled spend plus the amount, then resume. The amounts come from the
  // record that stopped the Thread, so the new limit is the one the user just read.
  const raiseBudget = useMutation({
    mutationFn: (addedUsdNanos: number) => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ budget_usd_nanos: (thread.data?.usage.cost_usd_nanos ?? 0) + addedUsdNanos }),
    }).then(() => transport.request<unknown>(`/api/threads/${encodeURIComponent(threadId)}/continue`, { method: "POST" })),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["history", threadId] }),
        client.invalidateQueries({ queryKey: ["thread", threadId] }),
        client.invalidateQueries({ queryKey: ["thread-response", threadId] }),
        client.invalidateQueries({ queryKey: ["threads"] }),
        client.invalidateQueries({ queryKey: ["reasoning-audits"] }),
      ])
    },
  })
  // Only the newest budget record offers the control: an older one may already
  // have been answered, and raising its limit would resume nothing.
  const actionableBudgetRecordId = useMemo(() => newestBudgetRecordId(durableRecords), [durableRecords])
  const running = thread.data?.status === "running"
  // Only stored records prove a call is still on the device: a streamed item the
  // preview renders carries the request's start time, not the call's own.
  // Every hook sits above the placeholders below: a Thread opened from its URL has no
  // list row to render from, so the first render is the placeholder and this memo would
  // only be reached one render later — React then throws #310 ("Rendered more hooks
  // than during the previous render") and the column dies instead of opening.
  const inFlightCalls = useMemo(() => inFlightCallIds(running ? durableRecords : []), [durableRecords, running])
  // An owned Thread is the controller's whole record; a source hands over a summary. Only the
  // owner's row is mirrored back to the host — a reader must not hand somebody else's Thread to
  // the chrome that renders this account's own.
  const ownedThread = source === undefined ? thread.data as Thread | undefined : undefined
  useEffect(() => {
    if (!ownedThread) return
    onThreadChange?.(ownedThread)
    onTitleChange?.(ownedThread.title)
  }, [ownedThread, onThreadChange, onTitleChange])
  useEffect(() => { onRecordsChange?.(records) }, [records, onRecordsChange])
  // A source's data space, named once: its scope separates cache entries by viewer, owner
  // and grant cycle, and both effects below work on exactly that scope.
  const scope = source?.scope
  const scopeKey = JSON.stringify(scope ?? null)
  useEffect(() => {
    if (scope === undefined) return
    // The reader keeps no copy after it closes: switching account, switching Thread or
    // leaving the reader drops this data space instead of leaving it cached.
    return () => {
      void client.cancelQueries({ queryKey: [...scope] })
      client.removeQueries({ queryKey: [...scope] })
    }
  }, [scope, scopeKey, client])
  const failed = thread.error
  const accessLost = source?.accessLost
  const onAccessLost = source?.onAccessLost
  useEffect(() => {
    if (accessLost === undefined || scope === undefined || !accessLost(failed)) return
    setDenied(true)
    setHalted(true)
    // Abort first, then drop the scope whole: a late page cannot repopulate what was just
    // removed, and the reader keeps no copy of a Thread it may no longer read.
    void client.cancelQueries({ queryKey: [...scope] })
    client.removeQueries({ queryKey: [...scope] })
    onAccessLost?.()
  }, [failed, accessLost, onAccessLost, scope, scopeKey, client])
  // Only this column settles into a placeholder; the Thread List is a sibling that already
  // rendered, so opening a Thread never blanks the layout around it.
  if (thread.isLoading) return <ThreadPending headerLeading={headerLeading} className={className} />
  // Rechecking restarts the switched-off reads instead of refetching one of them: the
  // source answers with whatever permission exists now, and the card stays put until then.
  if (denied) return <ThreadDenied language={language} headerLeading={headerLeading} className={className} onRetry={() => { setDenied(false); setHalted(false) }} />
  if (thread.isError || !thread.data) return <ThreadUnavailable error={thread.error} headerLeading={headerLeading} className={className} onRetry={() => void thread.refetch()} />
  const current = thread.data
  // A Thread states its own budget or follows the owner's default; a summary from a source
  // may state neither, and inventing the reader's default would misreport the Thread.
  const contextBudget = current.context_budget_tokens ?? defaults.data?.context_budget_tokens
  const contextTokens = current.context_tokens ?? null
  const minimal = minimalOverride ?? current.minimal_mode ?? defaults.data?.minimal_mode ?? false
  // A summary carries `archived_at` only when its owner's Thread is archived; absent
  // means "not stated", which must not render as archived.
  const archived = (current.archived_at ?? null) !== null
  const busy = submit.isPending || control.isPending
  // Attachments ride inside the message text, so what the Controller receives is
  // composed here; an input the Controller would refuse is flagged instead of sent.
  const composed = composeComposerInput(input, files.files, language)
  const oversize = composed.length > maxInputChars
  const submitInput = (recorded: string[] = []) => {
    const audios = [...audio.audios, ...recorded]
    if (busy || oversize) return
    // 只有一段语音、一个字没打，也是一条合法的消息：Controller 收的就是
    // 「没有文字、只有音频」的输入。以前这里按文本判空，于是对着麦克风说完
    // 点发送什么都不会发生。
    if (composed === "" && attachments.images.length === 0 && audios.length === 0) return
    submit.mutate({ draft: input, input: composed, images: attachments.images, audios })
  }
  // 录完先挂到附件上，再发。发送失败时它还挂在输入框上，重试不用重录。
  const sendVoice = async () => {
    const clip = await audio.finish()
    if (!clip) return
    audio.attach(clip)
    submitInput([clip])
  }
  const hasHistory = durableRecords.some((record) => record.kind !== "activity")
  const action = composerAction(input, attachments.images.length + files.files.length, running)
  return <section className={threadRootClass(className)}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
      {headerLeading}
      {editing && writable ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (title.trim()) rename.mutate(title.trim()) }}>
        <Input aria-label={t("threadName")} value={title} onChange={(event) => setTitle(event.target.value)} disabled={generateTitle.isPending} />
        <Button size="sm" disabled={rename.isPending || generateTitle.isPending}>{rename.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{t("rename")}</Button>
      </form> : <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {headerBreadcrumb && <div className="flex min-w-0 items-center">{headerBreadcrumb}</div>}
        <div className="flex min-w-0 items-center gap-1">
          <h1 className="min-w-0 truncate text-base font-semibold">{current.title}</h1>
          {archived && <Badge variant="outline" className="shrink-0 text-muted-foreground">{t("archived")}</Badge>}
          {current.created_by === "api" && <Badge variant="outline" className="shrink-0 text-muted-foreground" title={current.external_ref ? `${t("apiOriginHint")} · ${current.external_ref}` : t("apiOriginHint")}>{t("apiOrigin")}</Badge>}
          {writable && <><Button type="button" size="icon-sm" variant="outline" aria-label={t("generateTitle")} title={t("generateTitle")} disabled={generateTitle.isPending || !hasHistory} onClick={() => generateTitle.mutate()}>{generateTitle.isPending ? <Spinner /> : <SparklesIcon className="size-4" />}</Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("rename")} title={t("rename")} onClick={() => setEditing(true)}><PencilIcon className="size-4" /></Button></>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <ThreadStatusSummary status={current.display_status} runningSummary={current.running_summary} language={language} />
          {contextBudget !== undefined && <ThreadContextUsage context={{ tokens: contextTokens, budget: contextBudget }} language={language} />}
        </div>
      </div>}
      {headerActions}
    </div>
    <ThreadUsagePanel usage={current.usage} language={language} />
    {submit.error && <div className="shrink-0 p-3"><RequestError error={submit.error} onRetry={() => submitInput()} /></div>}
    {control.error && <div className="shrink-0 p-3"><RequestError error={control.error} /></div>}
    {generateTitle.error && <div className="shrink-0 p-3"><RequestError error={generateTitle.error} onRetry={() => generateTitle.mutate()} /></div>}
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        {/* The load-earlier control floats over the viewport instead of rendering as a transcript row:
            the scroller preserves the visible row on prepend only while the previous first content
            child moves down, and a control row kept at index 0 would defeat that detection. */}
        <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex flex-col items-center gap-2 px-6">
          {hasOlder && <Button className="pointer-events-auto shadow-sm" type="button" size="sm" variant="outline" disabled={loadEarlier.isPending} onClick={() => loadEarlier.mutate()}>
            {loadEarlier.isPending && <Spinner data-icon="inline-start" />}
            {loadEarlier.isPending ? t("loadingEarlierMessages") : t("loadEarlierMessages")}
          </Button>}
          {loadEarlier.error && <div className="pointer-events-auto w-full max-w-lg"><RequestError error={loadEarlier.error} onRetry={() => loadEarlier.mutate()} /></div>}
        </div>
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            {history.isLoading && <div className="flex flex-col gap-3"><Skeleton className="h-18" /><Skeleton className="ml-auto h-18 w-4/5" /></div>}
            {history.error && <RequestError error={history.error} onRetry={() => void history.refetch()} />}
            <ThreadHistory records={records} language={language} minimal={minimal} running={running} renderRecord={(record) => renderRecord ? renderRecord(record, { inFlight: recordInFlight(record, inFlightCalls) }) : <HistoryMessage language={language} record={record} workers={workers} manuals={manuals} inFlight={recordInFlight(record, inFlightCalls)} loadAudio={loadAudio} onRaiseBudget={writable && record.id === actionableBudgetRecordId && !running ? (addedUsdNanos: number) => raiseBudget.mutate(addedUsdNanos) : undefined} raisingBudget={raiseBudget.isPending} />} />
            {!history.isLoading && !history.error && durableRecords.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">{t("noHistory")}</div>}
            {liveResponse.data && <SafetyBufferingAlert language={language} view={liveResponse.data} running={current.status === "running"} />}
            {running && <MessageScrollerItem><div role="status"><ThreadStatusBadge status={current.display_status} runningSummary={current.running_summary} language={language} /></div></MessageScrollerItem>}
            {transcriptFooter}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScroller>
    </MessageScrollerProvider>
    {writable && <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); submitInput() }}>
      <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="thread-input">{t("input")}</FieldLabel><Textarea id="thread-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("input")} onKeyDown={handleChatInputKeyDown} onPaste={attachments.paste} disabled={busy} /><ComposerAttachments language={language} images={attachments.images} audios={audio.audios} files={files.files} onRemove={attachments.remove} onRemoveAudio={audio.remove} onRemoveFile={files.remove} /><ComposerFileNotice language={language} skipped={files.skipped} />{oversize && <ComposerLengthNotice language={language} chars={composed.length} limit={maxInputChars} />}<ComposerDraftNotice language={language} storageError={composer.storageError} /><ComposerAudioNotice language={language} error={audio.error} onDismiss={audio.dismissError} restored={audio.restored} onDismissRestored={audio.dismissRestored} onRetry={() => submitInput()} /></Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ComposerAttach language={language} disabled={busy} onFiles={attach} />
            {ownedThread && <ThreadSettingsButton threadId={threadId} value={ownedThread} disabled={busy} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" disabled={running || busy || !hasHistory} title={t("compactThreadHint")} onClick={() => control.mutate("compact")}>{control.isPending && control.variables === "compact" ? <Spinner data-icon="inline-start" /> : <Minimize2Icon data-icon="inline-start" />}{t("compactThread")}</Button>
            <ComposerAudio language={language} recording={audio.recording} phase={audio.phase} elapsed={audio.elapsed} disabled={busy} onStart={audio.start} onSend={() => void sendVoice()} onCancel={audio.cancel} />
            {action === "send"
              ? <Button disabled={busy || audio.recording || oversize}>{submit.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t("send")}</Button>
              : action === "stop"
                ? <Button type="button" variant="outline" disabled={busy} title={t("stopThreadHint")} onClick={() => control.mutate("cancel")}>{control.isPending && control.variables === "cancel" ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}{t("stopThread")}</Button>
                : <Button type="button" variant="outline" disabled={busy || !hasHistory} title={t("continueThreadHint")} onClick={() => control.mutate("continue")}>{control.isPending && control.variables === "continue" ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}{t("continueThread")}</Button>}
          </div>
        </div>
      </FieldGroup>
    </form>}
  </section>
}
function ThreadPending({ headerLeading, className }: { headerLeading?: ReactNode; className?: string }) {
  return <section className={threadRootClass(className)}>
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
      {headerLeading}
      <Skeleton className="h-5 w-56" />
    </div>
    <div className="flex flex-col gap-3 px-4 py-5"><Skeleton className="h-18" /><Skeleton className="ml-auto h-18 w-4/5" /></div>
  </section>
}

// Access was revoked or the Thread was deleted: the answer the reader gets offers a
// recheck instead of a retry, because retrying a dead grant only repeats the refusal.
function ThreadDenied({ language, headerLeading, className, onRetry }: { language: Language; headerLeading?: ReactNode; className?: string; onRetry: () => void }) {
  return <section className={threadRootClass(className)}>
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
      {headerLeading}
    </div>
    <div className="p-4"><Alert><AlertTitle>{language === "zh" ? "这个线程无法访问" : "This Thread is unavailable"}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2"><span>{language === "zh" ? "授权可能已撤销，或线程已被删除。已经复制的内容无法收回。" : "Access may have been revoked or the Thread deleted. Previously copied content cannot be recalled."}</span><Button size="sm" variant="outline" onClick={onRetry}>{language === "zh" ? "重新检查权限" : "Check access again"}</Button></AlertDescription></Alert></div>
  </section>
}

function ThreadUnavailable({ error, headerLeading, className, onRetry }: { error: unknown; headerLeading?: ReactNode; className?: string; onRetry: () => void }) {
  return <section className={threadRootClass(className)}>
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
      {headerLeading}
    </div>
    <div className="p-4"><RequestError error={error} onRetry={onRetry} /></div>
  </section>
}

function SafetyBufferingAlert({ language, view, running }: { language: Language; view: ThreadResponseView; running: boolean }) {
  const response = view.response
  const buffering = response.safety_buffering
  if (!running || response.completed || !buffering?.show_buffering_ui) return null
  return <MessageScrollerItem><Alert><Spinner /><AlertTitle>{language === "zh" ? "正在等待安全检查" : "Waiting for safety checks"}</AlertTitle><AlertDescription>{buffering.reasons.join(" · ")}</AlertDescription></Alert></MessageScrollerItem>
}

function RequestError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useCybion()
  return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t("loadError")}</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span className="break-words">{errorMessage(error)}</span>{onRetry && <Button size="sm" variant="outline" onClick={onRetry}>{t("retry")}</Button>}</AlertDescription></Alert>
}

