export type HistoryRecord = {
  id: number
  thread_id: string
  kind: "input" | "response_output" | "tool_output" | "checkpoint" | "activity"
  payload: unknown
  created_at: number
}

export type ThreadHistoryEntry =
  | { type: "message"; key: string; record: HistoryRecord }
  | { type: "process"; key: string; records: HistoryRecord[]; startedAt: number; finishedAt: number }

function isStandaloneRecord(record: HistoryRecord) {
  if (record.kind === "input" || record.kind === "activity") return true
  const payload = record.payload
  return record.kind === "response_output" && payload !== null && typeof payload === "object"
    && "type" in payload && payload.type === "message"
}

export function threadHistoryRecordKey(record: HistoryRecord) {
  const payload = record.payload
  // INVARIANT: Responses item IDs survive the preview-to-history handoff; synthetic row IDs do not.
  if (record.kind === "response_output" && payload !== null && typeof payload === "object"
    && "id" in payload && typeof payload.id === "string") return `${record.thread_id}:output:${payload.id}`
  return `${record.thread_id}:record:${record.id}:${record.created_at}`
}

// INVARIANT: thread history is append-only, so incremental polling can ask the server for
// records newer than the newest loaded one instead of reloading the whole thread.
export async function pollThreadHistory(
  previous: readonly HistoryRecord[] | undefined,
  fetchAfter: (after: number) => Promise<HistoryRecord[]>,
) {
  const after = previous?.reduce((newest, record) => Math.max(newest, record.id), 0) ?? 0
  return [...previous ?? [], ...await fetchAfter(after)]
}

export function groupThreadHistory(records: readonly HistoryRecord[]): ThreadHistoryEntry[] {
  const entries: ThreadHistoryEntry[] = []
  for (const record of records) {
    const key = threadHistoryRecordKey(record)
    if (isStandaloneRecord(record)) {
      entries.push({ type: "message", key, record })
      continue
    }
    const previous = entries.at(-1)
    if (previous?.type === "process") {
      previous.records.push(record)
      previous.startedAt = Math.min(previous.startedAt, record.created_at)
      previous.finishedAt = Math.max(previous.finishedAt, record.created_at)
      continue
    }
    entries.push({ type: "process", key: `process:${key}`, records: [record], startedAt: record.created_at, finishedAt: record.created_at })
  }
  return entries
}

export function formatThreadProcessDuration(durationSeconds: number, language: "en" | "zh") {
  const total = Math.max(0, Math.floor(durationSeconds))
  const hours = String(Math.floor(total / 3600)).padStart(2, "0")
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, "0")
  const seconds = String(total % 60).padStart(2, "0")
  return language === "zh"
    ? `运行了 ${hours} 小时 ${minutes} 分钟 ${seconds} 秒`
    : `Ran for ${hours}h ${minutes}m ${seconds}s`
}
