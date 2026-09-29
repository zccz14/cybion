import { formattedTime } from "@/lib/time"
import type { HistoryRecord } from "@/lib/thread-history"

export function HistoryRecordPayload({ language, record }: { language: "en" | "zh"; record: HistoryRecord }) {
  return <div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-background/70">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/50 px-3 py-2 text-[0.68rem] text-muted-foreground">
      <code className="font-mono">#{record.id}</code>
      <time>{formattedTime(language, record.created_at)}</time>
    </div>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-foreground">{JSON.stringify(record.payload, null, 2) ?? String(record.payload)}</pre>
  </div>
}
