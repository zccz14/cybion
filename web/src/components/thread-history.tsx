import { useMemo, type ReactNode } from "react"
import { groupThreadHistory, threadHistoryRecordKey, type HistoryRecord } from "@/lib/thread-history"
import { MessageScrollerItem } from "@/components/ui/message-scroller"
import { ThreadProcessGroup } from "@/components/thread-process-group"

export function ThreadHistory({ records, language, renderRecord }: {
  records: readonly HistoryRecord[]
  language: "en" | "zh"
  renderRecord: (record: HistoryRecord) => ReactNode
}) {
  const entries = useMemo(() => groupThreadHistory(records), [records])
  return entries.map((entry) => <MessageScrollerItem key={entry.key}>
    {entry.type === "process"
      ? <ThreadProcessGroup language={language} count={entry.records.length} durationSeconds={entry.finishedAt - entry.startedAt}>
        {entry.records.map((record) => <div key={threadHistoryRecordKey(record)} className="min-w-0">{renderRecord(record)}</div>)}
      </ThreadProcessGroup>
      : renderRecord(entry.record)}
  </MessageScrollerItem>)
}
