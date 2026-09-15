import type { ReactNode } from "react"
import { TerminalSquareIcon } from "lucide-react"
import type { BashFunctionCall } from "@/lib/history-payload"

export function BashCommand({ language, call, workers, time, children }: {
  language: "en" | "zh"
  call: BashFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
  time: string
  children: ReactNode
}) {
  const workerName = workers?.find((worker) => worker.id === call.workerId)?.label ?? call.workerId
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <TerminalSquareIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{language === "zh" ? `正在调用 ${workerName} 上的命令` : `Calling a command on ${workerName}`}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5">{call.command}</pre>
      {children}
    </div>
  </div>
}
