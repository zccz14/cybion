import { cybionToolFunctionCall } from "./history-payload.ts"
import type { HistoryRecord } from "./thread-history.ts"

// One `read_context` call the Thread made inside the context it still replays.
export type ThreadContextRead = {
  context_id: string
  calls: number
  first_record_id: number
  last_record_id: number
  last_read_at: number
}

// The controller answers with the calls inside `[head, tail]`, so a compaction
// removes exactly the reads its checkpoint replaced.
export type ThreadContextReadsView = {
  head: number | null
  tail: number | null
  calls: HistoryRecord[]
}

// INVARIANT: the controller returns the calls oldest first, so Map insertion order is
// the order the Thread discovered the Contexts in.
export function threadContextReads(calls: readonly HistoryRecord[]): ThreadContextRead[] {
  const reads = new Map<string, ThreadContextRead>()
  for (const record of calls) {
    const call = cybionToolFunctionCall(record.payload)
    if (call?.tool !== "read_context") continue
    // A Context id is a UUID: the tool argument and the Contexts page key may differ in case.
    const contextId = call.contextId.toLowerCase()
    const read = reads.get(contextId)
    reads.set(contextId, read
      ? { ...read, calls: read.calls + 1, last_record_id: record.id, last_read_at: record.created_at }
      : { context_id: contextId, calls: 1, first_record_id: record.id, last_record_id: record.id, last_read_at: record.created_at })
  }
  return [...reads.values()]
}

// The Contexts page addresses a Context by its full id; the Thread page shows the
// short form so a row of chips stays readable.
export function contextReadHash(contextId: string) {
  return contextId.slice(0, 8)
}
