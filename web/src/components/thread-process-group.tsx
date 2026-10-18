import type { ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useLiveSeconds } from "@/hooks/use-now"
import { formatThreadProcessDuration, threadProcessDuration } from "@/lib/thread-history"

const copy = {
  en: {
    title: "Process messages",
    durationHint: "Time between the earliest and latest messages in this group.",
    liveDurationHint: "Time from this group's earliest message until now: this run is still writing into it.",
    count: (count: number) => `${count} ${count === 1 ? "message" : "messages"}`,
  },
  zh: {
    title: "过程消息",
    durationHint: "本组最早一条消息到最晚一条消息的时间差。",
    liveDurationHint: "本组最早一条消息到现在的时间：本次执行仍在往这一组里写记录。",
    count: (count: number) => `${count} 条`,
  },
}

// The newest group of a running Thread is still growing, so its label follows a one-second
// clock instead of freezing at its latest record: a frozen counter reads as a stalled run.
function LiveProcessDuration({ language, startedAt, finishedAt }: { language: "en" | "zh"; startedAt: number; finishedAt: number }) {
  const now = useLiveSeconds()
  return <>{formatThreadProcessDuration(threadProcessDuration(startedAt, finishedAt, now), language)}</>
}

export function ThreadProcessGroup({ language, count, startedAt, finishedAt, running, children }: {
  language: "en" | "zh"
  count: number
  startedAt: number
  finishedAt: number
  running: boolean
  children: ReactNode
}) {
  const text = copy[language]
  return <details data-slot="thread-process-group" className="group/thread-process min-w-0 rounded-xl border border-border/70 bg-muted/20">
    <summary className="flex cursor-pointer list-none items-start gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 transition-transform group-open/thread-process:rotate-90 motion-reduce:transition-none" />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{text.title}</span>
        <span className="text-xs text-muted-foreground">{text.count(count)}</span>
        <span title={running ? text.liveDurationHint : text.durationHint} className="text-xs tabular-nums text-muted-foreground">
          {running
            ? <LiveProcessDuration language={language} startedAt={startedAt} finishedAt={finishedAt} />
            : formatThreadProcessDuration(finishedAt - startedAt, language)}
        </span>
      </span>
    </summary>
    <div className="flex min-w-0 flex-col gap-6 border-t border-border/70 p-3 sm:p-4">{children}</div>
  </details>
}
