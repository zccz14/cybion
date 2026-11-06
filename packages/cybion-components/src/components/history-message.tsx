import { memo } from "react"
import { ActivityIcon, ChevronDownIcon, CircleAlertIcon, SparklesIcon, TerminalSquareIcon } from "lucide-react"

import { Markdown } from "@zccz14/ux"

import type { Language } from "../api"
import { copyFor, type CopyKey } from "../copy"
import { formattedTime } from "../lib/time"
import {
  audioTranscriptionFunctionCall,
  bashFunctionCall,
  browserControlFunctionCall,
  computerUseFunctionCall,
  cybionToolFunctionCall,
  historyPayloadObject,
  historyPayloadText,
  imageGenerationFunctionCall,
  screenshotImageSource,
  viewImageFunctionCall,
  viewedImageSource,
  webSearchFunctionCall,
} from "../lib/history-payload"
import { threadControlAction, generatedImageSource } from "../lib/thread-response"
import { manualLoadNotice } from "../lib/thread-manual-loads"
import { threadHistoryRecordKey, type HistoryRecord } from "../lib/thread-history"
import { Badge } from "../ui/badge"
import { Message, MessageContent, MessageFooter } from "../ui/message"
import { AssistantMessage } from "./assistant-message"
import { AudioTranscriptionCall } from "./audio-transcription-call"
import { BashCommand } from "./bash-command"
import { BrowserControlCall } from "./browser-control-call"
import { CheckpointMessage } from "./checkpoint-message"
import { ComputerUseCall } from "./computer-use-call"
import { CybionToolCall } from "./cybion-tool-call"
import { HistoryRecordPayload } from "./history-record-payload"
import { ImageGenerationCall } from "./image-generation-call"
import { ManualLoadNotice } from "./manual-load-notice"
import { ScreenshotOutput } from "./screenshot-output"
import { UserInputMessage } from "./user-input-message"
import { ViewImageCall } from "./view-image-call"
import { ViewedOutput } from "./viewed-output"
import { WebSearchCall } from "./web-search-call"

export type Worker = { id: string; label: string }
export type ManualSummary = { name: string; description: string }

function historyRecordLabel(record: HistoryRecord, t: (key: CopyKey) => string) {
  if (isReasoningRecord(record)) return t("recordReasoning")
  if (record.kind === "tool_output") return t("recordToolOutput")
  if (record.kind === "activity") return t("recordActivity")
  return t("recordProtocol")
}

function isReasoningRecord(record: HistoryRecord) {
  return historyPayloadObject(record.payload)?.type === "reasoning"
}

function reasoningSummary(record: HistoryRecord) {
  const summary = historyPayloadObject(record.payload)?.summary
  if (!Array.isArray(summary)) return ""
  return summary
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text as string)
    .filter((text) => text.trim())
    .join("\n\n")
}

function historyRecordSummary(text: string) {
  const summary = text.replace(/\s+/g, " ").trim()
  if (!summary) return "—"
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary
}

function PayloadDetails({ language, record, label }: { language: Language; record: HistoryRecord; label: string }) {
  return <details className="group mt-2">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
      <span>{label}</span>
      <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
    </summary>
    <HistoryRecordPayload language={language} record={record} />
  </details>
}

/**
 * One stored record rendered as the conversation shows it: replies, the user's own
 * messages, tool calls, worker results, checkpoints and controller bookkeeping.
 * Hosts that render records themselves pass their own component to `CybionThreadView`;
 * this is the default that ships with the package.
 */
export const HistoryMessage = memo(function HistoryMessage({ language, record, workers, manuals, inFlight, loadAudio }: {
  language: Language
  record: HistoryRecord
  workers?: Worker[]
  manuals?: ReadonlyMap<string, ManualSummary>
  inFlight: boolean
  loadAudio?: (reference: string, mediaType: string | null) => Promise<string>
}) {
  const t = (key: CopyKey) => copyFor(language, key)
  const time = formattedTime(language, record.created_at)
  const action = threadControlAction(record)
  if (action) {
    const label = action === "cancel" ? t("threadStopped") : action === "continue" ? t("threadContinued") : t("threadCompactionRequested")
    return <Message><MessageContent><MessageFooter>{label} · {time}</MessageFooter></MessageContent></Message>
  }
  const imageSource = generatedImageSource(record.payload)
  if (imageSource) {
    return <Message>
      <MessageContent className="max-w-[75ch]">
        <img src={imageSource} alt={t("generatedImage")} loading="lazy" decoding="async" className="block h-auto max-w-full rounded-lg" />
        <MessageFooter>{t("generatedImage")} · #{record.id} · {time}</MessageFooter>
      </MessageContent>
    </Message>
  }
  if (record.kind === "input") {
    return <Message align="end">
      <MessageContent>
        <UserInputMessage language={language} payload={record.payload} footer={`#${record.id} · ${time}`} loadAudio={loadAudio} />
      </MessageContent>
    </Message>
  }
  const loadNotice = manualLoadNotice(record)
  if (loadNotice) {
    return <ManualLoadNotice notice={loadNotice} lookup={manuals} language={language} time={time} recordId={record.id} />
  }

  const text = historyPayloadText(record.payload)

  if (isReasoningRecord(record)) {
    const summary = reasoningSummary(record)
    return <div className="relative flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 dark:border-border dark:bg-card">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
        <SparklesIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-primary">{t("recordReasoning")}</span>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        {summary ? <div className="mt-2 break-words text-sm"><Markdown content={summary} /></div> : <p className="mt-2 text-sm text-muted-foreground">—</p>}
        <PayloadDetails language={language} record={record} label={t("recordPayload")} />
      </div>
    </div>
  }

  const payload = historyPayloadObject(record.payload)
  if (record.kind === "response_output" && payload?.type === "message") {
    return <AssistantMessage language={language} streaming={record.id < 0} text={text} time={time} />
  }

  if (record.kind === "tool_output") {
    const screenshot = record.screenshot ? screenshotImageSource(record.payload) : null
    const viewed = viewedImageSource(record.payload)
    return <div className="relative flex items-start gap-3 px-1">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
        <TerminalSquareIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{t("recordToolOutput")}</span>
          <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[0.68rem]">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            {t("worker")}
          </Badge>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        {viewed !== null
          ? <ViewedOutput language={language} source={viewed} />
          : screenshot !== null
            ? <ScreenshotOutput language={language} source={screenshot} />
            : <p className="mt-1 truncate text-sm text-muted-foreground">{historyRecordSummary(text)}</p>}
        <PayloadDetails language={language} record={record} label={t("recordPayload")} />
      </div>
    </div>
  }

  const bashCall = bashFunctionCall(payload)
  if (bashCall) {
    return <BashCommand language={language} call={bashCall} workers={workers} time={time} startedAt={record.created_at} inFlight={inFlight}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </BashCommand>
  }

  const transcriptionCall = audioTranscriptionFunctionCall(payload)
  if (transcriptionCall) {
    return <AudioTranscriptionCall language={language} call={transcriptionCall} time={time} />
  }

  const searchCall = webSearchFunctionCall(payload)
  if (searchCall) {
    return <WebSearchCall language={language} call={searchCall} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </WebSearchCall>
  }

  const imageCall = imageGenerationFunctionCall(payload)
  if (imageCall) {
    return <ImageGenerationCall language={language} call={imageCall} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </ImageGenerationCall>
  }

  const browserCall = browserControlFunctionCall(payload)
  if (browserCall) {
    return <BrowserControlCall language={language} call={browserCall} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </BrowserControlCall>
  }

  const computerCall = computerUseFunctionCall(payload)
  if (computerCall) {
    return <ComputerUseCall language={language} call={computerCall} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </ComputerUseCall>
  }

  const viewImageCall = viewImageFunctionCall(payload)
  if (viewImageCall) {
    return <ViewImageCall language={language} call={viewImageCall} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </ViewImageCall>
  }

  const cybionCall = cybionToolFunctionCall(payload)
  if (cybionCall) {
    return <CybionToolCall language={language} call={cybionCall} workers={workers} manuals={manuals} time={time}>
      <PayloadDetails language={language} record={record} label={t("recordPayload")} />
    </CybionToolCall>
  }

  if (record.kind === "checkpoint") {
    return <CheckpointMessage language={language} record={record} />
  }

  if (typeof payload?.type === "string" && (payload.type !== "message" || !text.trim())) {
    return <div className="relative flex items-start gap-3 px-1">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/80">
        <ActivityIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-muted-foreground">{historyRecordLabel(record, t)}</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[0.68rem] text-muted-foreground">{t("recordHidden")}</Badge>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{historyRecordSummary(text)}</p>
        <PayloadDetails language={language} record={record} label={t("recordPayload")} />
      </div>
    </div>
  }

  const isFailure = record.kind === "activity" && payload?.role === "system" && text.startsWith("Request failed:")
  return <div className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${isFailure ? "border-destructive/35 bg-destructive/5" : "border-border/70 bg-card/70"}`}>
    <div aria-hidden="true" className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ${isFailure ? "bg-destructive/10 text-destructive ring-destructive/20" : "bg-muted text-muted-foreground ring-border/80"}`}>
      {isFailure ? <CircleAlertIcon className="size-4" /> : <ActivityIcon className="size-4" />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${isFailure ? "text-destructive" : ""}`}>{historyRecordLabel(record, t)}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{text}</div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground">
        <span className="font-mono">#{record.id}</span>
        <span className="sr-only">{threadHistoryRecordKey(record)}</span>
      </div>
    </div>
  </div>
}, (previous, next) => previous.workers === next.workers && previous.manuals === next.manuals && previous.inFlight === next.inFlight && previous.language === next.language && previous.record.id === next.record.id && previous.record.thread_id === next.record.thread_id && previous.record.kind === next.record.kind && previous.record.payload === next.record.payload && previous.record.created_at === next.record.created_at && previous.record.screenshot === next.record.screenshot)
