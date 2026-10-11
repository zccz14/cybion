import type { ReactNode } from "react"
import { GlobeIcon } from "lucide-react"
import type { WebSearchFunctionCall } from "@/lib/history-payload"

const copy = {
  en: { title: "Web search" },
  zh: { title: "网页搜索" },
} as const

export function WebSearchCall({ language, call, time, children }: {
  language: "en" | "zh"
  call: WebSearchFunctionCall
  time: string
  children: ReactNode
}) {
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <GlobeIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{copy[language].title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6">{call.query}</p>
      {children}
    </div>
  </div>
}
