import { historyPayloadObject } from "./history-payload.ts"
import type { HistoryRecord } from "./thread-history.ts"

// The controller answers with the bindings the Thread holds and the range that
// replays, so a Manual whose copy sits behind the head is delivered again.
export type ThreadManualLoadsView = {
  head: number | null
  tail: number | null
  // Manuals the Thread keeps loaded, in the order it loaded them. These are
  // Thread state rather than message state: the controller carries each current
  // copy in every request, so they survive a compaction.
  loaded: string[]
  // The cap those bindings count against: this Thread's own setting, then the
  // account default, then the built-in one.
  limit: number
}

// A `manual_loaded`/`manual_unloaded` activity record: the controller's own
// note that the Thread now receives this Manual's JSON as a developer message,
// or that it stopped. It is appended before a request compiles, never rewritten,
// and the compiler replays the same record upstream.
export type ManualLoadNotice = { manual_id: string; loaded: boolean }

export function manualLoadNotice(record: HistoryRecord): ManualLoadNotice | null {
  if (record.kind !== "activity") return null
  const payload = historyPayloadObject(record.payload)
  if (payload?.type !== "manual_loaded" && payload?.type !== "manual_unloaded") return null
  return typeof payload.manual_id === "string"
    ? { manual_id: payload.manual_id.toLowerCase(), loaded: payload.type === "manual_loaded" }
    : null
}
