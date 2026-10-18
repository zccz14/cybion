import { useMemo, type ReactNode } from "react"
import { groupThreadHistory, groupThreadHistoryMinimal, liveThreadProcessKey, threadHistoryRecordKey, type HistoryRecord } from "@/lib/thread-history"
import { MessageScrollerItem } from "@/components/ui/message-scroller"
import { ThreadImageGroup } from "@/components/thread-image-group"
import { ThreadProcessGroup } from "@/components/thread-process-group"

export function ThreadHistory({ records, language, minimal, running, renderRecord }: {
  records: readonly HistoryRecord[]
  language: "en" | "zh"
  minimal: boolean
  running: boolean
  renderRecord: (record: HistoryRecord) => ReactNode
}) {
  const entries = useMemo(() => minimal ? groupThreadHistoryMinimal(records) : groupThreadHistory(records), [minimal, records])
  // While the Thread runs, only the newest process group keeps growing; every earlier group
  // keeps the span its own records prove.
  const liveKey = useMemo(() => running ? liveThreadProcessKey(entries) : null, [entries, running])
  // INVARIANT: a stable messageId per entry keeps the scroller able to anchor the viewport while
  // older pages are prepended.
  return entries.map((entry) => <MessageScrollerItem key={entry.key} messageId={entry.key}>
    {entry.type === "process" && <ThreadProcessGroup language={language} count={entry.records.length} startedAt={entry.startedAt} finishedAt={entry.finishedAt} running={entry.key === liveKey}>
      {entry.records.map((record) => <div key={threadHistoryRecordKey(record)} className="min-w-0">{renderRecord(record)}</div>)}
    </ThreadProcessGroup>}
    {entry.type === "message" && renderRecord(entry.record)}
    {entry.type === "image-group" && <ThreadImageGroup language={language} images={entry.records} />}
  </MessageScrollerItem>)
}
