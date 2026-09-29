import { ChevronDownIcon, DatabaseIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { HistoryRecordPayload } from "@/components/history-record-payload"
import { Markdown } from "@/components/markdown"
import { historyPayloadText } from "@/lib/history-payload"
import { formattedTime } from "@/lib/time"
import type { HistoryRecord } from "@/lib/thread-history"

const copy = {
  en: { label: "Checkpoint", internal: "Internal", payload: "View raw payload" },
  zh: { label: "上下文检查点", internal: "内部记录", payload: "查看原始负载" },
}

export function CheckpointMessage({ language, record }: { language: "en" | "zh"; record: HistoryRecord }) {
  const text = copy[language]
  return <div data-slot="checkpoint-message" className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/80">
      <DatabaseIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span data-slot="checkpoint-label" className="text-sm font-medium text-muted-foreground">{text.label}</span>
        <Badge variant="outline" className="h-5 px-1.5 text-[0.68rem] text-muted-foreground">{text.internal}</Badge>
        <time className="text-xs text-muted-foreground">{formattedTime(language, record.created_at)}</time>
      </div>
      <div data-slot="checkpoint-content" className="mt-2 max-w-[75ch] rounded-2xl rounded-tl-md bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/10">
        <div className="prose prose-sm max-w-none break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">
          <Markdown>{historyPayloadText(record.payload)}</Markdown>
        </div>
      </div>
      <details className="group mt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span>{text.payload}</span>
          <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <HistoryRecordPayload language={language} record={record} />
      </details>
    </div>
  </div>
}
