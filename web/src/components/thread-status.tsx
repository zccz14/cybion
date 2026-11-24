import { CheckIcon, CirclePauseIcon, GitBranchIcon, LoaderIcon, MessageSquareDashedIcon, Minimize2Icon, SquareIcon, TriangleAlertIcon } from "lucide-react"
import { NavLink, useLocation } from "react-router-dom"
import { useNowSeconds } from "@zccz14/cybion-components/internal"
import { formatRelativeTime } from "@zccz14/cybion-components/internal"
import { threadStatusLabel, threadStatusText, type ThreadDisplayStatus } from "@zccz14/cybion-components/internal"
import { cn } from "@zccz14/cybion-components/internal"
import type { ThreadUsage } from "@zccz14/cybion-components/internal"
import { ThreadUsageSummary, ThreadUsageDetails } from "@zccz14/cybion-components/internal"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type StatusProps = { status: ThreadDisplayStatus; language: "en" | "zh"; runningSummary?: string | null }

// How many child Threads a row has is secondary information, so it is named the
// same way on every row and reads as one more item on the row's second line.
const branchesCopy = { en: "{count} child Threads", zh: "{count} 个子线程" } satisfies Record<"en" | "zh", string>

const presentation = {
  ready: { icon: MessageSquareDashedIcon, color: "text-muted-foreground", motion: "" },
  running: { icon: LoaderIcon, color: "text-thread-active", motion: "motion-safe:animate-spin motion-safe:[animation-duration:1.5s]" },
  compacting: { icon: Minimize2Icon, color: "text-thread-active", motion: "" },
  completed: { icon: CheckIcon, color: "text-thread-success", motion: "" },
  failed: { icon: TriangleAlertIcon, color: "text-thread-failure", motion: "" },
  stopped: { icon: SquareIcon, color: "text-muted-foreground", motion: "" },
  blocked: { icon: CirclePauseIcon, color: "text-thread-blocked", motion: "" },
} as const

// Exported so a compact surface (the branch footer) shows the same icon and
// colour the Thread list shows for the same status, instead of inventing a
// second vocabulary.
export function ThreadStatusIcon({ status, className }: { status: ThreadDisplayStatus; className?: string }) {
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

export function ThreadLink({ thread, language, to, badge }: {
  thread: { created_by?: "web" | "api"; external_ref?: string | null; id: string; title: string; display_status: ThreadDisplayStatus; running_summary?: string | null; updated_at: number; usage: ThreadUsage; branches?: number }
  language: StatusProps["language"]
  /** Where the row points. Defaults to this account's own Thread; a shared row
   * points at the owner's copy instead. */
  to?: string
  /** Extra qualifier on the title line, e.g. the owner of a shared Thread. */
  badge?: React.ReactNode
}) {
  const status = thread.display_status
  const location = useLocation()
  const now = useNowSeconds()
  const { label, statusTitle } = statusLabelAndTitle(status, language, thread.running_summary)
  const summary = status === "running" ? thread.running_summary?.trim() ?? "" : ""
  const { hint } = threadStatusText(status, language)
  const branches = thread.branches ?? 0
  return <Tooltip>
    <TooltipTrigger asChild>
      <NavLink to={to ?? { pathname: `/threads/${thread.id}`, search: location.search }} data-thread-status={status} className="flex min-w-0 items-start gap-2.5 rounded-lg px-3 py-2 text-sm ring-1 ring-inset ring-transparent hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:ring-border">
        <ThreadStatusIcon status={status} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span data-slot="thread-title" className="truncate font-medium">{thread.title}</span>
            {thread.created_by === "api" && <span className="shrink-0 rounded border px-1 text-[0.65rem] font-normal text-muted-foreground">API</span>}
            {badge}
            <time data-slot="thread-updated-at" dateTime={new Date(thread.updated_at * 1000).toISOString()} className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{formatRelativeTime(language, thread.updated_at, now)}</time>
          </span>
          <span data-slot="thread-status-label" title={statusTitle} className={cn("min-w-0 truncate text-xs", presentation[status].color)}>{label}</span>
          {/* The row has one secondary line: usage numbers and the branch count share
              it and wrap together, so neither ever takes a column of its own. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
            <ThreadUsageSummary usage={thread.usage} language={language} />
            {branches > 0 && <span data-slot="thread-branches" title={branchesCopy[language].replace("{count}", String(branches))} className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap">
              <GitBranchIcon aria-hidden="true" className="size-3" />{branches}
            </span>}
          </span>
        </span>
      </NavLink>
    </TooltipTrigger>
    <TooltipContent side="right" className="max-w-72 flex-col items-start motion-reduce:animate-none">
      <span className="max-w-full break-words font-medium">{thread.title}</span>
      {summary !== "" && <span className="max-w-full break-words">{summary}</span>}
      <span>{hint}</span>
      {thread.created_by === "api" && <span className="max-w-full break-words">{language === "zh" ? "由集成 API 创建" : "Created via the integration API"}{thread.external_ref ? ` · ${thread.external_ref}` : ""}</span>}
      <div className="mt-2 w-full border-t border-current/20 pt-2"><ThreadUsageDetails usage={thread.usage} language={language} /></div>
    </TooltipContent>
  </Tooltip>
}
