import { Link } from "react-router-dom"
import type { ContextSummary } from "@/components/cybion-tool-call"
import type { ContextReadState, ThreadContextRead, ThreadContextReadsView } from "@/lib/thread-context-reads"

const copy = {
  zh: {
    label: "已读上下文",
    empty: "本窗口内没有读取上下文",
    unknown: "未知上下文",
    scope: "本线程在当前上下文窗口内用 read_context 读取过的上下文：模型手里是不是还是现在这一版，会标在名字后面；压缩成 checkpoint 后，被压缩掉的读取会从这里消失。",
    reads: (calls: number) => `读取 ${calls} 次`,
    readAt: (record: number) => `最近读取 #${record}`,
    state: { changed: "已改", unanswered: "未读到", missing: "已不存在" },
    changedHint: "读取之后这个上下文被改过，当前这版已经不是模型手里的那版。",
    unansweredHint: "这次读取没有把正文交给模型。",
    missingHint: "这个上下文现在读不到了。",
  },
  en: {
    label: "Read contexts",
    empty: "no context read in this window",
    unknown: "Unknown context",
    scope: "Contexts this Thread read with read_context inside the context it still replays. A name is marked when what the model holds is no longer the current copy; a compaction drops the reads its checkpoint replaced.",
    reads: (calls: number) => calls === 1 ? "read once" : `read ${calls} times`,
    readAt: (record: number) => `last read #${record}`,
    state: { changed: "edited", unanswered: "not read", missing: "gone" },
    changedHint: "This Context changed after the read, so what the model holds is an older copy.",
    unansweredHint: "This read handed the model no Context body.",
    missingHint: "This Context can no longer be read.",
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
  view: Pick<ThreadContextReadsView, "head" | "tail">
  language: "en" | "zh"
}) {
  const text = copy[language]
  return <div data-slot="thread-context-reads" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span title={text.scope} className="whitespace-nowrap">{text.label} <strong className="font-medium tabular-nums text-foreground">{reads.length}</strong></span>
    {view.head !== null && view.tail !== null && <span className="whitespace-nowrap font-mono text-[0.7rem]">#{view.head}–#{view.tail}</span>}
    {reads.length === 0
      ? <span className="whitespace-nowrap">{text.empty}</span>
      : reads.map((read) => <ContextReadChip key={read.context_id} read={read} context={lookup?.get(read.context_id) ?? null} language={language} />)}
  </div>
}

function ContextReadChip({ read, context, language }: {
  read: ThreadContextRead
  context: ContextSummary | null
  language: "en" | "zh"
}) {
  const text = copy[language]
  const detail = [read.context_id, text.readAt(read.last_record_id), text.reads(read.calls)]
  if (read.state !== "current") detail.unshift(text[`${read.state}Hint`])
  return <Link
    to={`/contexts?context=${encodeURIComponent(read.context_id)}`}
    title={detail.join("\n")}
    className="flex min-w-0 max-w-48 items-center gap-1 rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="truncate font-medium">{context?.name ?? text.unknown}</span>
    {read.state !== "current" && <span className={`shrink-0 ${stateTone[read.state]}`}>{text.state[read.state]}</span>}
  </Link>
}
