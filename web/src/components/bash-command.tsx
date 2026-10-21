import type { ReactNode } from "react"
import { TerminalSquareIcon } from "lucide-react"
import { useLiveSeconds } from "@/hooks/use-now"
import { bashCallCountdown, type BashFunctionCall } from "@/lib/history-payload"
import { formatStatsDuration } from "@/lib/time"

const copy = {
  en: {
    calling: (worker: string) => `Calling a command on ${worker}`,
    delayed: (seconds: string) => `Waiting to start · ${seconds} left`,
    running: (seconds: string) => `Running · ${seconds} to timeout`,
    expired: "Past the timeout · cancelling",
  },
  zh: {
    calling: (worker: string) => `正在调用 ${worker} 上的命令`,
    delayed: (seconds: string) => `延迟等待中 · 还剩 ${seconds}`,
    running: (seconds: string) => `执行中 · 超时还剩 ${seconds}`,
    expired: "已过超时 · 正在取消",
  },
} as const

export function BashCommand({ language, call, workers, time, startedAt, inFlight, children }: {
  language: "en" | "zh"
  call: BashFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
  time: string
  startedAt: number
  inFlight: boolean
  children: ReactNode
}) {
  const text = copy[language]
  const workerName = workers?.find((worker) => worker.id === call.workerId)?.label ?? call.workerId
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <TerminalSquareIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{text.calling(workerName)}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5">{call.command}</pre>
      {inFlight && <BashCallCountdown language={language} call={call} startedAt={startedAt} />}
      {children}
    </div>
  </div>
}

// A call in flight is the one card whose deadline the user can still miss, so it
// counts down on a one-second clock that exists only while the call is running.
function BashCallCountdown({ language, call, startedAt }: { language: "en" | "zh"; call: BashFunctionCall; startedAt: number }) {
  const now = useLiveSeconds()
  const countdown = bashCallCountdown(call, startedAt, now)
  const text = copy[language]
  return <p data-slot="bash-countdown" data-phase={countdown.phase} className="mt-1.5 text-xs tabular-nums text-muted-foreground">
    {countdown.phase === "expired"
      ? text.expired
      : countdown.phase === "delayed"
        ? text.delayed(formatStatsDuration(countdown.seconds, language))
        : text.running(formatStatsDuration(countdown.seconds, language))}
  </p>
}
