import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowDownIcon, CheckIcon, ChevronDownIcon, LoaderIcon, Minimize2Icon, PencilIcon,
  SendIcon, SparklesIcon, SquareIcon,
} from "lucide-react"

import { Markdown } from "@zccz14/ux"

import type { Language, Thread, ThreadDefaults, UpstreamModels } from "./api"
import { CybionApiError } from "./api"
import { useCybion } from "./provider"
import { HistoryMessage, type ManualSummary, type Worker } from "./components/history-message"
import { ThreadHistory } from "./components/thread-history"
import { ThreadSettingsPopover } from "./components/thread-settings-popover"
import { ThreadContextUsage, ThreadUsagePanel } from "./components/thread-usage"
import { ThreadStatusSummary } from "./components/thread-status"
import { ComposerAttachments } from "./components/composer-attachments"
import { ComposerAudio } from "./components/composer-audio"
import { useComposerAudio } from "./hooks/use-composer-audio"
import { useComposerDraft } from "./hooks/use-composer-draft"
import { useComposerImages } from "./hooks/use-composer-images"
import { handleChatInputKeyDown } from "./lib/chat-input"
import { newestRecordId, oldestRecordId, recordInFlight, inFlightCallIds, loadedThreadRecords, type HistoryRecord, type ThreadHistoryWindow } from "./lib/thread-history"
import { pendingResponseRecords, type ThreadResponseView } from "./lib/thread-response"
import { Button } from "./ui/button"
import { Badge } from "./ui/badge"
import { Field, FieldGroup, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "./ui/message-scroller"
import { Message, MessageContent, MessageFooter } from "./ui/message"
import { Spinner } from "./ui/spinner"
import { Textarea } from "./ui/textarea"

const pollIntervalMs = 2000

export type CybionThreadViewProps = {
  /** The only required input: the thread to show. */
  threadId: string
  className?: string
  /** A first message the host already has outside the thread (a ticket body, an email). */
  intro?: { body: string; createdAt: number }
  /** Called whenever the stored title changes, so a host can mirror it. */
  onTitleChange?: (title: string) => void
  /** Replace the default record renderer (rich cards for workers, tools, images). */
  renderRecord?: (record: HistoryRecord) => ReactNode
  readOnly?: boolean
}

/**
 * The whole thread: title, status, usage, history, and the composer with model
 * settings, compaction, continuation and voice input. Data comes from the Cybion
 * browser API through the provider's client, so the host passes a thread ID only.
 */
export function CybionThreadView({ threadId, className, intro, onTitleChange, renderRecord, readOnly = false }: CybionThreadViewProps) {
  const { client, language, identity, t } = useCybion()
  const draft = useComposerDraft(identity, threadId)
  const attachments = useComposerImages()
  const audio = useComposerAudio()
  const [thread, setThread] = useState<Thread | null>(null)
  const [defaults, setDefaults] = useState<ThreadDefaults | null>(null)
  const [catalogs, setCatalogs] = useState<UpstreamModels | null>(null)
  const [historyWindow, setHistoryWindow] = useState<ThreadHistoryWindow | null>(null)
  const [olderPages, setOlderPages] = useState<ThreadHistoryWindow[]>([])
  const [liveResponse, setLiveResponse] = useState<ThreadResponseView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const recordsRef = useRef<HistoryRecord[]>([])
  const loadAudio = useMemo(() => async (reference: string, mediaType: string | null) => {
    const blob = await client.object(reference)
    return URL.createObjectURL(mediaType ? new Blob([blob], { type: mediaType }) : blob)
  }, [client])
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  const records = useMemo(() => {
    const durable = loadedThreadRecords(olderPages, historyWindow ?? undefined)
    return [...durable, ...pendingResponseRecords(liveResponse, durable, threadId)]
  }, [olderPages, historyWindow, liveResponse, threadId])

  recordsRef.current = records
  const running = thread?.status === "running"

  const refreshThread = useCallback(async () => {
    const next = await client.thread(threadId)
    setThread(next)
    return next
  }, [client, threadId])

  const refreshHistory = useCallback(async () => {
    const current = recordsRef.current
    const durable = current.filter((record) => record.id > 0)
    if (durable.length === 0) {
      setHistoryWindow(await client.historyWindow(threadId))
      return
    }
    const fresh = await client.history(threadId, newestRecordId(durable))
    if (fresh.length > 0) {
      setHistoryWindow((previous) => previous === null ? previous : { ...previous, records: [...previous.records, ...fresh] })
    }
  }, [client, threadId])

  const refreshResponse = useCallback(async () => {
    setLiveResponse(await client.response(threadId))
  }, [client, threadId])

  const refreshAll = useCallback(async () => {
    try {
      const [, , response] = await Promise.all([refreshThread(), refreshHistory(), client.response(threadId)])
      setLiveResponse(response)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [client, refreshThread, refreshHistory, threadId])

  useEffect(() => {
    let cancelled = false
    Promise.all([client.thread(threadId), client.historyWindow(threadId), client.defaults(), client.modelCatalog()])
      .then(([nextThread, nextWindow, nextDefaults, nextCatalogs]) => {
        if (cancelled) return
        setThread(nextThread)
        setHistoryWindow(nextWindow)
        setDefaults(nextDefaults)
        setCatalogs(nextCatalogs)
        setTitleDraft(nextThread.title)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { cancelled = true }
  }, [client, threadId])

  useEffect(() => {
    setOlderPages([])
    setHistoryWindow(null)
    setThread(null)
    setLiveResponse(null)
    setEditing(false)
  }, [threadId])

  useEffect(() => {
    const timer = setInterval(() => { void refreshAll() }, pollIntervalMs)
    return () => clearInterval(timer)
  }, [refreshAll])

  useEffect(() => {
    if (thread && thread.title) onTitleChange?.(thread.title)
  }, [thread?.title, onTitleChange])

  const submit = useCallback(async (recorded: string[] = []) => {
    const input = draft.input
    const audios = [...audio.audios, ...recorded]
    if (pending || (!input.trim() && attachments.images.length === 0 && audios.length === 0)) return
    setPending(true)
    setError(null)
    try {
      await client.sendInput(threadId, { input, images: attachments.images, audios })
      draft.clearSubmitted(input)
      attachments.clear()
      audio.clear()
      await refreshAll()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [audio, attachments, client, draft, pending, refreshAll, threadId])

  const control = useCallback(async (action: "cancel" | "continue" | "compact") => {
    setPending(true)
    try {
      await client.control(threadId, action)
      await refreshAll()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [client, refreshAll, threadId])

  const rename = useCallback(async () => {
    const title = titleDraft.trim()
    if (!title) return
    try {
      const next = await client.update(threadId, { title })
      setThread(next)
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [client, threadId, titleDraft])

  const generateTitle = useCallback(async () => {
    try {
      setThread(await client.generateTitle(threadId))
      setEditing(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [client, threadId])

  const updateSettings = useCallback(async (patch: Parameters<typeof client.update>[1]) => {
    try {
      setThread(await client.update(threadId, patch))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [client, threadId])

  const loadEarlier = useCallback(async () => {
    const before = oldestRecordId(records.filter((record) => record.id > 0))
    if (before === null) return
    setLoadingEarlier(true)
    try {
      const page = await client.historyWindow(threadId, before)
      setOlderPages((previous) => [...previous, page])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoadingEarlier(false)
    }
  }, [client, records, threadId])

  const inFlightCalls = useMemo(() => inFlightCallIds(running ? records.filter((record) => record.id > 0) : []), [records, running])
  const hasOlder = olderPages[0]?.hasOlder ?? historyWindow?.hasOlder ?? false
  const contextBudget = thread?.context_budget_tokens ?? defaults?.context_budget_tokens
  const busy = pending || audio.recording
  const hasHistory = records.some((record) => record.kind !== "activity")

  return <section className={`flex min-h-0 min-w-0 flex-1 flex-col ${className ?? ""}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
      {editing ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void rename() }}>
        <Input aria-label={t("threadName")} value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
        <Button size="sm" disabled={!titleDraft.trim()}>{t("rename")}</Button>
      </form> : <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1">
          <h2 className="min-w-0 truncate text-base font-semibold">{thread?.title ?? ""}</h2>
          {thread !== null && thread.archived_at !== null && <Badge variant="outline" className="shrink-0 text-muted-foreground">{t("archived")}</Badge>}
          {thread?.created_by === "api" && <Badge variant="outline" className="shrink-0 text-muted-foreground" title={thread.external_ref ?? t("apiOriginHint")}>{t("apiOrigin")}</Badge>}
          {!readOnly && <>
            <Button type="button" size="icon-sm" variant="outline" aria-label={t("generateTitle")} title={t("generateTitle")} disabled={!hasHistory} onClick={() => void generateTitle()}><SparklesIcon className="size-4" /></Button>
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t("rename")} title={t("rename")} onClick={() => setEditing(true)}><PencilIcon className="size-4" /></Button>
          </>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          {thread && <ThreadStatusSummary status={thread.display_status} runningSummary={thread.running_summary} language={language} />}
          {contextBudget !== undefined && <ThreadContextUsage context={{ tokens: thread?.context_tokens ?? null, budget: contextBudget }} language={language} />}
        </div>
      </div>}
    </div>
    {thread && <ThreadUsagePanel usage={thread.usage} language={language} />}
    {error && <p className="shrink-0 px-4 py-2 text-xs text-destructive">{error}</p>}
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex flex-col items-center gap-2 px-6">
          {hasOlder && <Button className="pointer-events-auto shadow-sm" type="button" size="sm" variant="outline" disabled={loadingEarlier} onClick={() => void loadEarlier()}>
            {loadingEarlier ? t("loadingEarlierMessages") : t("loadEarlierMessages")}
          </Button>}
        </div>
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            {intro && <MessageScrollerItem>
              <Message align="end">
                <MessageContent>
                  <Markdown content={intro.body} />
                  <MessageFooter>{new Date(intro.createdAt * 1000).toLocaleString(language === "zh" ? "zh-CN" : "en")}</MessageFooter>
                </MessageContent>
              </Message>
            </MessageScrollerItem>}
            <ThreadHistory records={records} language={language} minimal={thread?.minimal_mode ?? defaults?.minimal_mode ?? false} running={running}
              renderRecord={(record) => renderRecord
                ? renderRecord(record)
                : <HistoryMessage language={language} record={record} workers={undefined as Worker[] | undefined} manuals={undefined as ReadonlyMap<string, ManualSummary> | undefined} inFlight={recordInFlight(record, inFlightCalls)} loadAudio={loadAudio} />} />
            {!running && records.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">{t("noHistory")}</div>}
            {running && <MessageScrollerItem><div role="status" className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"><LoaderIcon className="size-3.5 animate-spin" />{thread?.running_summary ?? t("recordActivity")}</div></MessageScrollerItem>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScroller>
    </MessageScrollerProvider>
    {!readOnly && <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <FieldGroup><Field>
        <FieldLabel className="sr-only" htmlFor={`cybion-thread-input-${threadId}`}>{t("input")}</FieldLabel>
        <Textarea id={`cybion-thread-input-${threadId}`} value={draft.input} onChange={(event) => draft.setInput(event.target.value)} placeholder={t("input")} onKeyDown={handleChatInputKeyDown} onPaste={attachments.paste} disabled={busy} />
        <ComposerAttachments language={language} images={attachments.images} audios={audio.audios} onRemove={attachments.remove} onRemoveAudio={audio.remove} />
      </Field>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {thread && <ThreadSettingsPopover model={thread.model} upstreamId={thread.upstream_id} catalogs={catalogs?.upstreams} reasoningEffort={thread.reasoning_effort} fast={thread.service_tier_fast} language={language} disabled={busy}
            onModelChange={(upstream_id, model) => void updateSettings({ upstream_id, model })}
            onReasoningChange={(reasoning_effort) => void updateSettings({ reasoning_effort })}
            onFastChange={(service_tier_fast) => void updateSettings({ service_tier_fast })} />}
          <div className="flex flex-wrap items-center gap-2">
            {thread && <Button type="button" variant="ghost" disabled={running || busy || !hasHistory} title={t("compactThreadHint")} onClick={() => void control("compact")}><Minimize2Icon data-icon="inline-start" />{t("compactThread")}</Button>}
            <ComposerAudio language={language} recording={audio.recording} disabled={busy} onStart={audio.start} onSend={() => void audio.finish().then((dataUrl) => { if (dataUrl) void submit([dataUrl]) })} onCancel={audio.cancel} />
            {running
              ? <Button type="button" variant="outline" disabled={pending} onClick={() => void control("cancel")}><SquareIcon data-icon="inline-start" />{t("stop")}</Button>
              : <Button type="submit" disabled={pending || (!draft.input.trim() && attachments.images.length === 0 && audio.audios.length === 0)}>
                {pending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t("send")}
              </Button>}
          </div>
        </div>
      </FieldGroup>
    </form>}
  </section>
}
