import { BookOpenIcon, BookXIcon } from "lucide-react"
import { Link } from "react-router-dom"
import type { ManualSummary } from "@/components/cybion-tool-call"

const copy = {
  zh: {
    loaded: "已加载手册，完整 JSON 已注入请求",
    loadedBody: "控制器在这条记录之后插入了一条 developer 消息，携带该手册的完整 JSON。手册被改动、或历史被压缩成检查点之后，控制器会自己再补一份最新副本，模型不需要重新读取。",
    unloaded: "已卸载手册",
    unloadedBody: "本线程不再保持这个手册：已经注入的副本留在会话里直到下次压缩，此后不再刷新，也不得再作为依据。",
    unknown: "未知手册",
  },
  en: {
    loaded: "Manual loaded — its JSON is in the request",
    loadedBody: "The controller put this Manual's full JSON into the request as a developer message right after this record. When the Manual changes, or a compaction replaces the history, it delivers a fresh copy by itself; the model never reads it again to stay current.",
    unloaded: "Manual unloaded",
    unloadedBody: "This Thread no longer keeps this Manual: the copy already in the conversation stays until the next compaction and is no longer refreshed, and the model is told not to rely on it.",
    unknown: "Unknown manual",
  },
} as const

export function ManualLoadNotice({ notice, lookup, language, time, recordId }: {
  notice: { manual_id: string; loaded: boolean }
  lookup: ReadonlyMap<string, ManualSummary> | undefined
  language: "en" | "zh"
  time: string
  recordId: number
}) {
  const text = copy[language]
  const loaded = notice.loaded
  const tone = loaded
    ? "border-sky-600/30 bg-sky-500/5 dark:border-sky-400/25 dark:bg-sky-400/5"
    : "border-border bg-muted/40"
  const markTone = loaded
    ? "bg-sky-500/10 text-sky-600 ring-1 ring-sky-600/20 dark:text-sky-400 dark:ring-sky-400/25"
    : "bg-muted text-muted-foreground ring-1 ring-border"
  return <div data-slot="manual-load-notice" className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${tone}`}>
    <div aria-hidden="true" className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${markTone}`}>
      {loaded ? <BookOpenIcon className="size-4" /> : <BookXIcon className="size-4" />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${loaded ? "text-sky-700 dark:text-sky-300" : "text-muted-foreground"}`}>{loaded ? text.loaded : text.unloaded}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{loaded ? text.loadedBody : text.unloadedBody}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Link to={`/manuals?manual=${encodeURIComponent(notice.manual_id)}`} title={notice.manual_id} className="rounded-full border bg-card px-2 py-0.5 text-xs font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lookup?.get(notice.manual_id)?.name ?? text.unknown}</Link>
      </div>
      <div className="mt-2 text-[0.68rem] text-muted-foreground"><span className="font-mono">#{recordId}</span></div>
    </div>
  </div>
}
