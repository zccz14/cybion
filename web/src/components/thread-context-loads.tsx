import { Link } from "react-router-dom"
import type { ContextSummary } from "@/components/cybion-tool-call"
import type { ThreadContextLoadsView } from "@/lib/thread-context-loads"

const copy = {
  zh: {
    label: "已加载上下文",
    empty: "本线程没有加载上下文",
    loadedLabel: "已加载",
    scope: "本线程用 load_context 加载的上下文：控制器在每个请求里都带上它的最新副本，压缩之后也会重新送达，卸载之后就不再刷新。",
    hint: "控制器会持续把它的最新副本送进请求，不需要模型重新读取。",
    unknown: "未知上下文",
  },
  en: {
    label: "Loaded contexts",
    empty: "no context loaded in this thread",
    loadedLabel: "loaded",
    scope: "Contexts this Thread loaded with load_context. The controller carries each current copy in every request — including after a compaction — and stops refreshing it once it is unloaded.",
    hint: "The controller keeps delivering its current copy, so nothing re-reads it.",
    unknown: "Unknown context",
  },
} as const

export function ThreadContextLoads({ view, lookup, language }: {
  view: ThreadContextLoadsView
  lookup: ReadonlyMap<string, ContextSummary> | undefined
  language: "en" | "zh"
}) {
  const text = copy[language]
  // A Context id is a UUID: the binding and the Contexts page key may differ in case.
  const loaded = view.loaded.map((id) => id.toLowerCase())
  return <div data-slot="thread-context-loads" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span title={text.scope} className="whitespace-nowrap">{text.label} <strong className="font-medium tabular-nums text-foreground">{loaded.length}</strong></span>
    {view.head !== null && view.tail !== null && <span className="whitespace-nowrap font-mono text-[0.7rem]">#{view.head}–#{view.tail}</span>}
    {loaded.length === 0
      ? <span className="whitespace-nowrap">{text.empty}</span>
      : loaded.map((id) => <Link
        key={id}
        to={`/contexts?context=${encodeURIComponent(id)}`}
        title={[id, text.hint].join("\n")}
        className="flex min-w-0 max-w-48 items-center gap-1 rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate font-medium">{lookup?.get(id)?.name ?? text.unknown}</span>
        <span className="shrink-0 text-sky-600 dark:text-sky-400">{text.loadedLabel}</span>
      </Link>)}
  </div>
}
