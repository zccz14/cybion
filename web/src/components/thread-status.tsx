import { CheckIcon, LoaderIcon, MessageSquareDashedIcon, Minimize2Icon, SquareIcon, TriangleAlertIcon } from "lucide-react"
import { NavLink } from "react-router-dom"
import { threadStatusText, type ThreadDisplayStatus } from "@/lib/thread-status"
import { cn } from "@/lib/utils"
import type { ThreadUsage } from "@/lib/thread-usage"
import { ThreadUsageSummary, ThreadUsageDetails } from "@/components/thread-usage"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type StatusProps = { status: ThreadDisplayStatus; language: "en" | "zh" }

const presentation = {
  ready: { icon: MessageSquareDashedIcon, color: "text-muted-foreground", motion: "" },
  running: { icon: LoaderIcon, color: "text-thread-active", motion: "motion-safe:animate-spin motion-safe:[animation-duration:1.5s]" },
  compacting: { icon: Minimize2Icon, color: "text-thread-active", motion: "" },
  completed: { icon: CheckIcon, color: "text-thread-success", motion: "" },
  failed: { icon: TriangleAlertIcon, color: "text-thread-failure", motion: "" },
  stopped: { icon: SquareIcon, color: "text-muted-foreground", motion: "" },
} as const

function ThreadStatusIcon({ status, className }: { status: ThreadDisplayStatus; className?: string }) {
  const { icon: Icon, color, motion } = presentation[status]
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", color, motion, className)} />
}

export function ThreadStatusBadge({ status, language }: StatusProps) {
  const { label, hint } = threadStatusText(status, language)
  return <span data-thread-status={status} title={hint} className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-current/15 bg-current/5 px-2 py-1 text-xs font-medium", presentation[status].color)}>
    <ThreadStatusIcon status={status} />
    <span>{label}</span>
  </span>
}

export function ThreadLink({ thread, language }: { thread: { id: string; title: string; display_status: ThreadDisplayStatus; usage: ThreadUsage }; language: StatusProps["language"] }) {
  const status = thread.display_status
  const { label, hint } = threadStatusText(status, language)
  return <Tooltip>
    <TooltipTrigger asChild>
      <NavLink to={`/threads/${thread.id}`} data-thread-status={status} className="flex min-w-0 items-start gap-2.5 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-transparent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:ring-border">
        <ThreadStatusIcon status={status} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{thread.title}</span>
          <span className={cn("text-xs", presentation[status].color)}>{label}</span>
          <ThreadUsageSummary usage={thread.usage} language={language} />
        </span>
      </NavLink>
    </TooltipTrigger>
    <TooltipContent side="right" className="max-w-72 flex-col items-start motion-reduce:animate-none">
      <span className="max-w-full break-words font-medium">{thread.title}</span>
      <span>{hint}</span>
      <div className="mt-2 w-full border-t border-current/20 pt-2"><ThreadUsageDetails usage={thread.usage} language={language} /></div>
    </TooltipContent>
  </Tooltip>
}
