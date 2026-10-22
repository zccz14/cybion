import { Link } from "react-router-dom"
import type { ManualSummary } from "@/components/cybion-tool-call"
import type { ThreadManualLoadsView } from "@/lib/thread-manual-loads"

const copy = {
  zh: {
    label: "已加载手册",
    empty: "本线程没有加载手册",
    scope: "本线程用 load_manual 加载的手册：控制器在每个请求里都带上它的最新副本，压缩之后也会重新送达，卸载之后就不再刷新。上限由本线程设置或账号默认决定。",
    hint: "控制器会持续把它的最新副本送进请求，不需要模型重新读取。",
    unknown: "未知手册",
  },
  en: {
    label: "Loaded manuals",
    empty: "no manual loaded in this thread",
    scope: "Manuals this Thread loaded with load_manual. The controller carries each current copy in every request — including after a compaction — and stops refreshing it once it is unloaded. The cap comes from this Thread's setting or the account default.",
    hint: "The controller keeps delivering its current copy, so nothing re-reads it.",
    unknown: "Unknown manual",
  },
} as const

export function ThreadManualLoads({ view, lookup, language }: {
  view: ThreadManualLoadsView
  lookup: ReadonlyMap<string, ManualSummary> | undefined
  language: "en" | "zh"
}) {
  const text = copy[language]
  // A Manual id is a UUID: the binding and the Manuals page key may differ in case.
  const loaded = view.loaded.map((id) => id.toLowerCase())
  return <div data-slot="thread-manual-loads" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span title={text.scope} className="whitespace-nowrap">{text.label} <strong className="font-medium tabular-nums text-foreground">{loaded.length}</strong> / <span className="tabular-nums">{view.limit}</span></span>
    {view.head !== null && view.tail !== null && <span className="whitespace-nowrap font-mono text-[0.7rem]">#{view.head}–#{view.tail}</span>}
    {loaded.length === 0
      ? <span className="whitespace-nowrap">{text.empty}</span>
      : loaded.map((id) => <Link
        key={id}
        to={`/manuals?manual=${encodeURIComponent(id)}`}
        title={[id, text.hint].join("\n")}
        className="flex min-w-0 max-w-48 items-center rounded-full border bg-card px-2 py-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate font-medium">{lookup?.get(id)?.name ?? text.unknown}</span>
      </Link>)}
  </div>
}
