import { Link } from "react-router-dom"
import type { ContextSummary } from "@/components/cybion-tool-call"
import type { ContextReadState, ThreadContextRead, ThreadContextReadsView } from "@/lib/thread-context-reads"

const copy = {
  zh: {
    label: "已读上下文",
    empty: "本窗口内没有读取上下文",
    loadedLabel: "已加载",
    loadedOnly: "已加载上下文",
    scope: "本线程在当前上下文窗口内用 read_context 读取过的上下文：模型手里是不是还是现在这一版，会标在名字后面；压缩成 checkpoint 后，被压缩掉的读取会从这里消失。",
    loadedScope: "本线程用 load_context 加载的上下文：控制器在每个请求里都带上它的最新副本，压缩之后也会重新送达，卸载之后就不再刷新。",
    reads: (calls: number) => `读取 ${calls} 次`,
    readAt: (record: number) => `最近读取 #${record}`,
    loadedHint: "控制器会持续把它的最新副本送进请求，不需要模型重新读取。",
    state: { changed: "已改", unanswered: "未读到", missing: "已不存在" },
    changedHint: "读取之后这个上下文被改过，当前这版已经不是模型手里的那版。",
    unansweredHint: "这次读取没有把正文交给模型。",
    missingHint: "这个上下文现在读不到了。",
    unknown: "未知上下文",
  },
  en: {
    label: "Read contexts",
    empty: "no context read in this window",
    loadedLabel: "loaded",
    loadedOnly: "Loaded contexts",
    scope: "Contexts this Thread read with read_context inside the context it still replays. A name is marked when what the model holds is no longer the current copy; a compaction drops the reads its checkpoint replaced.",
    loadedScope: "Contexts this Thread loaded with load_context. The controller carries each current copy in every request — including after a compaction — and stops refreshing it once it is unloaded.",
    reads: (calls: number) => calls === 1 ? "read once" : `read ${calls} times`,
    readAt: (record: number) => `last read #${record}`,
    loadedHint: "The controller keeps delivering its current copy, so the model never re-reads it.",
    state: { changed: "edited", unanswered: "not read", missing: "gone" },
    changedHint: "This Context changed after the read, so what the model holds is an older copy.",
    unansweredHint: "This read handed the model no Context body.",
    missingHint: "This Context can no longer be read.",
    unknown: "Unknown context",
  },
} as const

const stateTone: Record<Exclude<ContextReadState, "current">, string> = {
  changed: "text-amber-600 dark:text-amber-400",
  unanswered: "text-destructive",
  missing: "text-muted-foreground",
}

export function ThreadContextReads({ reads, lookup, view, language }: {
  reads: readonly ThreadContextRead[]
  lookup: ReadonlyMap<string, ContextSummary> | undefined
  view: Pick<ThreadContextReadsView, "head" | "tail" | "loaded">
  language: "en" | "zh"
}) {
  const text = copy[language]
  const loaded = (view.loaded ?? []).map((id) => id.toLowerCase())
  const loadedSet = new Set(loaded)
  // A loaded Context the Thread never read still occupies the request, so the
  // row shows it beside the reads instead of pretending it is not there.
  const readIds = new Set(reads.map((read) => read.context_id))
  const only = loaded.filter((id) => !readIds.has(id))
  return <div data-slot="thread-context-reads" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span title={text.scope} className="whitespace-nowrap">{text.label} <strong className="font-medium tabular-nums text-foreground">{reads.length}</strong></span>
    {only.length > 0 && <span title={text.loadedScope} className="whitespace-nowrap">{text.loadedLabel} <strong className="font-medium tabular-nums text-foreground">{only.length}</strong></span>}
    {view.head !== null && view.tail !== null && <span className="whitespace-nowrap font-mono text-[0.7rem]">#{view.head}–#{view.tail}</span>}
    {reads.length === 0 && only.length === 0
      ? <span className="whitespace-nowrap">{text.empty}</span>
      : <>
        {reads.map((read) => <ContextReadChip key={read.context_id} read={read} loaded={loadedSet.has(read.context_id)} context={lookup?.get(read.context_id) ?? null} language={language} />)}
        {only.map((id) => <LoadedContextChip key={id} contextId={id} context={lookup?.get(id) ?? null} language={language} />)}
      </>}
  </div>
}

function ContextReadChip({ read, loaded, context, language }: {
  read: ThreadContextRead
  loaded: boolean
  context: ContextSummary | null
  language: "en" | "zh"
}) {
  const text = copy[language]
  const detail = [read.context_id, text.readAt(read.last_record_id), text.reads(read.calls)]
  if (loaded) detail.push(text.loadedHint)
  if (read.state !== "current" && !loaded) detail.unshift(text[`${read.state}Hint`])
  return <Link
    to={`/contexts?context=${encodeURIComponent(read.context_id)}`}
    title={detail.join("\n")}
    data-loaded={loaded || undefined}
    className="flex min-w-0 max-w-48 items-center gap-1 rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="truncate font-medium">{context?.name ?? text.unknown}</span>
    {loaded && <span className="shrink-0 text-sky-600 dark:text-sky-400">{text.loadedLabel}</span>}
    {!loaded && read.state !== "current" && <span className={`shrink-0 ${stateTone[read.state]}`}>{text.state[read.state]}</span>}
    {read.calls > 1 && <span className="shrink-0 tabular-nums text-muted-foreground">×{read.calls}</span>}
  </Link>
}

function LoadedContextChip({ contextId, context, language }: {
  contextId: string
  context: ContextSummary | null
  language: "en" | "zh"
}) {
  const text = copy[language]
  return <Link
    to={`/contexts?context=${encodeURIComponent(contextId)}`}
    title={[contextId, text.loadedHint].join("\n")}
    className="flex min-w-0 max-w-48 items-center gap-1 rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="truncate font-medium">{context?.name ?? text.unknown}</span>
    <span className="shrink-0 text-sky-600 dark:text-sky-400">{text.loadedLabel}</span>
  </Link>
}
