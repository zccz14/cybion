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

export type ThreadHistoryWindow = {
  records: HistoryRecord[]
  hasOlder: boolean
}

// INVARIANT: olderPages stays ordered oldest first, so flattening it before the live window
// keeps every loaded record in ascending record order.
export function loadedThreadRecords(pages: readonly ThreadHistoryWindow[], window: ThreadHistoryWindow | undefined) {
  return [...pages.flatMap((page) => page.records), ...(window?.records ?? [])]
}

export function newestRecordId(records: readonly HistoryRecord[]) {
  return records.reduce((newest, record) => Math.max(newest, record.id), 0)
}

// INVARIANT: loaded records stay ordered by record id, so the first record is the cursor for
// the page just before this window.
export function oldestRecordId(records: readonly HistoryRecord[]) {
  return records.length > 0 ? records[0].id : null
}

// INVARIANT: thread history is append-only, so incremental polling can ask the server for
// records newer than the newest loaded one instead of reloading the whole thread. The first
// load asks for the tail window that starts at the most recent user input.
export async function pollThreadHistory(
  previous: ThreadHistoryWindow | undefined,
  loadWindow: () => Promise<ThreadHistoryWindow>,
  fetchAfter: (after: number) => Promise<HistoryRecord[]>,
): Promise<ThreadHistoryWindow> {
  if (!previous) return loadWindow()
  return { ...previous, records: [...previous.records, ...await fetchAfter(newestRecordId(previous.records))] }
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
