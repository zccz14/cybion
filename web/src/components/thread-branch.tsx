import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GitBranchIcon, SquareIcon } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

type BranchPool = {
  thread_id: string
  budget_usd: number | null
  subtree_spent_usd: number
  allotted_usd: number
  remaining_usd: number | null
}

type BranchNode = {
  thread_id: string
  title: string
  depth: number
  status: "idle" | "running" | "failed"
  blocked: boolean
  budget_usd: number | null
  subtree_spent_usd: number
  children: number
  updated_at: number
}

type BranchView = { pool: BranchPool; nodes: BranchNode[]; truncated: boolean }

type ThreadBranchRequest = <T>(path: string, init?: RequestInit) => Promise<T>

const copy = {
  zh: {
    label: "分支",
    pool: "本线程的额度：已花 {spent}，已分包 {allotted}，可用 {remaining}",
    unlimited: "已花 {spent}，未设上限",
    branch: "{children} 个子线程，正在等你就绪的会显示为受阻",
    stop: "停止这一轮",
    truncated: "只列出前 50 个",
  },
  en: {
    label: "Branches",
    pool: "This Thread's budget: {spent} settled, {allotted} promised, {remaining} left",
    unlimited: "{spent} settled, no ceiling set",
    branch: "{children} child Threads; one waiting on you reads as blocked",
    stop: "Stop this turn",
    truncated: "The first 50 only",
  },
} as const

function money(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return "<$0.01"
  return `$${dollars.toFixed(2)}`
}

function dotClass(node: BranchNode): string {
  if (node.status === "running") return "bg-thread-active"
  if (node.blocked) return "bg-thread-blocked"
  if (node.status === "failed") return "bg-thread-failure"
  return "bg-muted-foreground/50"
}

// The Threads this one subcontracted, with the pool they are spending from.
// Same row shape as the notes and manual rows in the same footer: one line per
// thing, money on the right, and no control the server would refuse — a slice
// is raised by the Thread above it, a turn is stopped here.
export function ThreadBranch({ threadId, active, language, request }: {
  threadId: string
  /** Whether this Thread can have a branch or a ceiling of its own. A Thread
   * with neither asks for nothing: the row does not exist for it. */
  active: boolean
  language: "en" | "zh"
  request: ThreadBranchRequest
}) {
  const text = copy[language]
  const client = useQueryClient()
  const branch = useQuery({
    queryKey: ["thread-branch", threadId],
    queryFn: ({ signal }) => request<BranchView>(`/api/threads/${encodeURIComponent(threadId)}/branches`, { signal }),
    refetchInterval: 5000,
    staleTime: 5000,
    enabled: active && Boolean(threadId),
  })
  const stop = useMutation({
    mutationFn: (id: string) => request<unknown>(`/api/threads/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["thread-branch", threadId] }) },
  })
  const view = branch.data
  // The row is an addition to a footer that must never grow a line of its own
  // when the branch is unknown: a Thread served by an older controller, or a
  // response that is not the branch view, simply has nothing to say here.
  if (!view || !view.pool || !Array.isArray(view.nodes)) return null
  // A Thread that never subcontracted and carries no ceiling has nothing to
  // say here, and most Threads are that Thread: the row stays out of the way.
  if (view.pool.budget_usd === null && view.nodes.length === 0) return null
  const spent = view.pool.subtree_spent_usd
  const summary = view.pool.budget_usd === null
    ? text.unlimited.replace("{spent}", money(spent))
    : text.pool
      .replace("{spent}", money(spent))
      .replace("{allotted}", money(view.pool.allotted_usd))
      .replace("{remaining}", money(view.pool.remaining_usd ?? 0))
  return <div data-slot="thread-branch" className="border-t pt-3">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span title={text.branch.replace("{children}", String(view.nodes.length))} className="flex items-center gap-1 whitespace-nowrap">
        <GitBranchIcon aria-hidden="true" className="size-3.5" />
        {text.label} <strong className="font-medium tabular-nums text-foreground">{view.nodes.length}</strong>
      </span>
      <span className="tabular-nums">{summary}</span>
      {view.truncated && <span>{text.truncated}</span>}
    </div>
    {view.nodes.length > 0 && <ul className="mt-1 flex flex-col gap-1 text-xs">
      {view.nodes.map((node) => <li key={node.thread_id} className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dotClass(node)}`} />
        <Link to={`/threads/${encodeURIComponent(node.thread_id)}`} className="min-w-0 flex-1 truncate hover:underline">{node.title}</Link>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {money(node.subtree_spent_usd)}{node.budget_usd !== null && ` / ${money(node.budget_usd)}`}
        </span>
        {node.status === "running" && <Button variant="ghost" size="icon-sm" aria-label={text.stop} title={text.stop} disabled={stop.isPending} onClick={() => stop.mutate(node.thread_id)}>
          {stop.isPending && stop.variables === node.thread_id ? <Spinner /> : <SquareIcon aria-hidden="true" />}
        </Button>}
      </li>)}
    </ul>}
  </div>
}
