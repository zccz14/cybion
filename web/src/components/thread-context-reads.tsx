import { Link } from "react-router-dom"
import type { ContextSummary } from "@/components/cybion-tool-call"
import { contextReadHash, type ThreadContextRead, type ThreadContextReadsView } from "@/lib/thread-context-reads"

const copy = {
  zh: {
    label: "已读上下文",
    empty: "本窗口内没有读取上下文",
    unknown: "未知上下文",
    scope: "本线程在当前上下文窗口内用 read_context 读取过的上下文。压缩成 checkpoint 后，被压缩掉的那些读取会从这里消失。",
    reads: (calls: number) => `读取 ${calls} 次`,
  },
  en: {
    label: "Read contexts",
    empty: "no context read in this window",
    unknown: "Unknown context",
    scope: "Contexts this Thread read with read_context inside the context it still replays. Compaction replaces them with its checkpoint, so the reads it rewrote leave this list.",
    reads: (calls: number) => calls === 1 ? "read once" : `read ${calls} times`,
  },
} as const

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
  return <Link
    to={`/contexts?context=${encodeURIComponent(read.context_id)}`}
    title={`${read.context_id} · ${text.reads(read.calls)}`}
    className="flex min-w-0 max-w-48 items-center gap-1 rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <span className="truncate font-medium">{context?.name ?? text.unknown}</span>
    <code className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">{contextReadHash(read.context_id)}</code>
    {read.calls > 1 && <span className="shrink-0 tabular-nums text-muted-foreground">×{read.calls}</span>}
  </Link>
}
