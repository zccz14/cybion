import { useState } from "react"
import { PlusIcon, SearchIcon } from "lucide-react"
import { ThreadLink } from "@/components/thread-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { matchesThreadQuery } from "@/lib/thread-search"
import type { ThreadDisplayStatus } from "@/lib/thread-status"
import type { ThreadUsage } from "@/lib/thread-usage"

export type ThreadListItem = {
  id: string
  title: string
  display_status: ThreadDisplayStatus
  usage: ThreadUsage
}

type ThreadListCopyKey = "threads" | "newThread" | "searchThreads" | "emptyTitle" | "emptySearch"

const copy = {
  en: { threads: "Threads", newThread: "New thread", searchThreads: "Search thread titles", emptyTitle: "No threads yet", emptySearch: "No threads match your search" },
  zh: { threads: "线程", newThread: "新建线程", searchThreads: "搜索线程标题", emptyTitle: "还没有线程", emptySearch: "没有匹配的线程" },
} satisfies Record<"en" | "zh", Record<ThreadListCopyKey, string>>

export function ThreadList({ threads, loading, language, onCreate }: { threads: ThreadListItem[]; loading: boolean; language: "en" | "zh"; onCreate: () => void }) {
  const t = copy[language]
  const [query, setQuery] = useState("")
  const visible = threads.filter((thread) => matchesThreadQuery(thread, query))
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b p-3">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" aria-label={t.searchThreads} placeholder={t.searchThreads} className="pl-8" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <Button size="icon-sm" variant="outline" aria-label={t.newThread} onClick={onCreate}><PlusIcon /></Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {loading
        ? <div className="flex flex-col gap-2"><Skeleton className="h-18" /><Skeleton className="h-18" /><Skeleton className="h-18" /></div>
        : <nav aria-label={t.threads} className="flex flex-col gap-1">
          {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{query.trim() ? t.emptySearch : t.emptyTitle}</p>}
          {visible.map((thread) => <ThreadLink key={thread.id} thread={thread} language={language} />)}
        </nav>}
    </div>
  </div>
}
