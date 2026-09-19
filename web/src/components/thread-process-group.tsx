import type { ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { formatThreadProcessDuration } from "@/lib/thread-history"

const copy = {
  en: { title: "Process messages", durationHint: "Time between the earliest and latest messages in this group.", count: (count: number) => `${count} ${count === 1 ? "message" : "messages"}` },
  zh: { title: "过程消息", durationHint: "本组最早一条消息到最晚一条消息的时间差。", count: (count: number) => `${count} 条` },
}

export function ThreadProcessGroup({ language, count, durationSeconds, children }: {
  language: "en" | "zh"
  count: number
  durationSeconds: number
  children: ReactNode
}) {
  const text = copy[language]
  return <details data-slot="thread-process-group" className="group/thread-process min-w-0 rounded-xl border border-border/70 bg-muted/20">
    <summary className="flex cursor-pointer list-none items-start gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 transition-transform group-open/thread-process:rotate-90 motion-reduce:transition-none" />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{text.title}</span>
        <span className="text-xs text-muted-foreground">{text.count(count)}</span>
        <span title={text.durationHint} className="text-xs tabular-nums text-muted-foreground">{formatThreadProcessDuration(durationSeconds, language)}</span>
      </span>
    </summary>
    <div className="flex min-w-0 flex-col gap-6 border-t border-border/70 p-3 sm:p-4">{children}</div>
  </details>
}
