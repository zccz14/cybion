import { ChevronDownIcon, DatabaseIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { HistoryRecordPayload } from "@/components/history-record-payload"
import { Markdown } from "@zccz14/ux"
import { checkpointPreview } from "@/lib/checkpoint-text"
import { historyPayloadText } from "@/lib/history-payload"
import { formattedTime } from "@/lib/time"
import type { HistoryRecord } from "@/lib/thread-history"

const copy = {
  en: {
    label: "Checkpoint",
    internal: "Internal",
    hint: "Manual compressed into Markdown — open to read it",
    payload: "View raw payload",
  },
  zh: {
    label: "上下文检查点",
    internal: "内部记录",
    hint: "上下文已压缩为 Markdown，点开可读",
    payload: "查看原始负载",
  },
}

// The card itself stays in the conversation like a reply: only its body is folded, so the
// transcript keeps the compression point visible while the Markdown it carries stays behind
// one deliberate step.
export function CheckpointMessage({ language, record }: { language: "en" | "zh"; record: HistoryRecord }) {
  const text = copy[language]
  const markdown = historyPayloadText(record.payload)
  return <details data-slot="checkpoint-message" className="group/checkpoint min-w-0 rounded-xl border border-dashed border-border/70 bg-muted/20">
    <summary className="flex cursor-pointer list-none items-start gap-2 rounded-xl px-3 py-2.5 text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/80">
        <DatabaseIcon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span data-slot="checkpoint-label" className="font-medium text-muted-foreground">{text.label}</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[0.68rem] text-muted-foreground">{text.internal}</Badge>
          <time className="text-xs text-muted-foreground">{formattedTime(language, record.created_at)}</time>
        </span>
        <span data-slot="checkpoint-preview" className="mt-0.5 block truncate text-xs text-muted-foreground">
          {checkpointPreview(markdown) || text.hint}
        </span>
      </span>
      <ChevronDownIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open/checkpoint:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="flex min-w-0 flex-col gap-2 border-t border-border/70 p-3 sm:p-4">
      <div data-slot="checkpoint-content" className="max-w-[75ch] break-words text-sm">
        <Markdown content={markdown} />
      </div>
      <details className="group/payload">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span>{text.payload}</span>
          <ChevronDownIcon className="size-3.5 transition-transform group-open/payload:rotate-180 motion-reduce:transition-none" />
        </summary>
        <HistoryRecordPayload language={language} record={record} />
      </details>
    </div>
  </details>
}
