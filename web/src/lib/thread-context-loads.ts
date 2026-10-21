import { historyPayloadObject } from "./history-payload.ts"
import type { HistoryRecord } from "./thread-history.ts"

// The controller answers with the bindings the Thread holds and the range that
// replays, so a Context whose copy sits behind the head is delivered again.
export type ThreadContextLoadsView = {
  head: number | null
  tail: number | null
  // Contexts the Thread keeps loaded, in the order it loaded them. These are
  // Thread state rather than message state: the controller carries each current
  // copy in every request, so they survive a compaction.
  loaded: string[]
}

// A `context_loaded`/`context_unloaded` activity record: the controller's own
// note that the Thread now receives this Context's JSON as a developer message,
// or that it stopped. It is appended before a request compiles, never rewritten,
// and the compiler replays the same record upstream.
export type ContextLoadNotice = { context_id: string; loaded: boolean }

export function contextLoadNotice(record: HistoryRecord): ContextLoadNotice | null {
  if (record.kind !== "activity") return null
  const payload = historyPayloadObject(record.payload)
  if (payload?.type !== "context_loaded" && payload?.type !== "context_unloaded") return null
  return typeof payload.context_id === "string"
    ? { context_id: payload.context_id.toLowerCase(), loaded: payload.type === "context_loaded" }
    : null
}
