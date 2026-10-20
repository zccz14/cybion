import { RefreshCwIcon } from "lucide-react"
import { Link } from "react-router-dom"
import type { ContextSummary } from "@/components/cybion-tool-call"

const copy = {
  zh: {
    title: "上下文已变更，已要求模型重读",
    body: "以下上下文在这次读取之后被改过；控制器在本次请求里插入了这条 developer 消息。被改过的上下文重新读取前，模型不应再依赖旧内容。",
    unknown: "未知上下文",
  },
  en: {
    title: "Contexts changed — the model was asked to re-read",
    body: "These Contexts changed after the Thread read them, so the controller put this developer message into the request. Until a Context is read again, the model should not rely on the copy it has.",
    unknown: "Unknown context",
  },
} as const

export function ContextDirtyNotice({ contexts, lookup, language, time, recordId }: {
  contexts: readonly string[]
  lookup: ReadonlyMap<string, ContextSummary> | undefined
  language: "en" | "zh"
  time: string
  recordId: number
}) {
  const text = copy[language]
  return <div data-slot="context-dirty-notice" className="flex items-start gap-3 rounded-xl border border-amber-600/30 bg-amber-500/5 px-3 py-3 dark:border-amber-400/25 dark:bg-amber-400/5">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 ring-1 ring-amber-600/20 dark:text-amber-400 dark:ring-amber-400/25">
      <RefreshCwIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">{text.title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{text.body}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {contexts.map((id) => <Link key={id} to={`/contexts?context=${encodeURIComponent(id)}`} title={id} className="rounded-full border bg-card px-2 py-0.5 text-xs font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lookup?.get(id)?.name ?? text.unknown}</Link>)}
      </div>
      <div className="mt-2 text-[0.68rem] text-muted-foreground"><span className="font-mono">#{recordId}</span></div>
    </div>
  </div>
}
