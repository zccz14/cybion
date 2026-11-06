import { CheckIcon, CirclePauseIcon, LoaderIcon, MessageSquareDashedIcon, Minimize2Icon, SquareIcon, TriangleAlertIcon } from "lucide-react"
import { useNowSeconds } from "../hooks/use-now"
import { formatRelativeTime } from "../lib/time"
import { threadStatusLabel, threadStatusText, type ThreadDisplayStatus } from "../lib/thread-status"
import { cn } from "../lib/utils"
import type { ThreadUsage } from "../lib/thread-usage"
import { ThreadUsageSummary, ThreadUsageDetails } from "./thread-usage"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

type StatusProps = { status: ThreadDisplayStatus; language: "en" | "zh"; runningSummary?: string | null }

const presentation = {
  ready: { icon: MessageSquareDashedIcon, color: "text-muted-foreground", motion: "" },
  running: { icon: LoaderIcon, color: "text-thread-active", motion: "motion-safe:animate-spin motion-safe:[animation-duration:1.5s]" },
  compacting: { icon: Minimize2Icon, color: "text-thread-active", motion: "" },
  completed: { icon: CheckIcon, color: "text-thread-success", motion: "" },
  failed: { icon: TriangleAlertIcon, color: "text-thread-failure", motion: "" },
  stopped: { icon: SquareIcon, color: "text-muted-foreground", motion: "" },
  blocked: { icon: CirclePauseIcon, color: "text-thread-blocked", motion: "" },
} as const

function ThreadStatusIcon({ status, className }: { status: ThreadDisplayStatus; className?: string }) {
  const { icon: Icon, color, motion } = presentation[status]
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", color, motion, className)} />
}

// A summary replaces the label rather than decorating it, so the full text
// moves into the title when the row truncates it.
function statusLabelAndTitle(status: ThreadDisplayStatus, language: "en" | "zh", runningSummary?: string | null) {
  const { label: canonical, hint } = threadStatusText(status, language)
  const label = threadStatusLabel(status, language, runningSummary)
  return { label, statusTitle: label === canonical ? hint : `${label} · ${hint}` }
}

export function ThreadStatusSummary({ status, language, runningSummary }: StatusProps) {
  const { label, statusTitle } = statusLabelAndTitle(status, language, runningSummary)
  return <span data-thread-status={status} title={statusTitle} className={cn("inline-flex w-fit min-w-0 max-w-full items-center gap-1 text-xs", presentation[status].color)}>
    <ThreadStatusIcon status={status} className="size-3.5" />
    <span className="min-w-0 truncate">{label}</span>
  </span>
}

export function ThreadStatusBadge({ status, language, runningSummary }: StatusProps) {
  const { label, statusTitle } = statusLabelAndTitle(status, language, runningSummary)
  return <span data-thread-status={status} title={statusTitle} className={cn("inline-flex min-w-0 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-current/15 bg-current/5 px-2 py-1 text-xs font-medium", presentation[status].color)}>
    <ThreadStatusIcon status={status} />
    <span className="min-w-0 truncate">{label}</span>
  </span>
}

