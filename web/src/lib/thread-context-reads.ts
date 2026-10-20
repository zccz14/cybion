import { cybionToolFunctionCall, historyPayloadObject } from "./history-payload.ts"
import type { HistoryRecord } from "./thread-history.ts"

// Whether the Context a read answered with is still the current copy, as the
// controller judged it when the page asked.
export type ContextReadState = "current" | "changed" | "unanswered" | "missing"

export type ThreadContextReadCall = HistoryRecord & { state: ContextReadState }

// The controller answers with the calls inside `[head, tail]`, so a compaction
// removes exactly the reads its checkpoint replaced.
export type ThreadContextReadsView = {
  head: number | null
  tail: number | null
  calls: ThreadContextReadCall[]
}

export type ThreadContextRead = {
  context_id: string
  calls: number
  first_record_id: number
  last_record_id: number
  last_read_at: number
  state: ContextReadState
}

// INVARIANT: the controller returns the calls oldest first, so Map insertion order is
// the order the Thread discovered the Contexts in. The newest read of a Context is the
// copy that counts: a Thread that read it before and after an edit holds the edit.
export function threadContextReads(calls: readonly ThreadContextReadCall[]): ThreadContextRead[] {
  const reads = new Map<string, ThreadContextRead>()
  for (const record of calls) {
    const call = cybionToolFunctionCall(record.payload)
    if (call?.tool !== "read_context") continue
    // A Context id is a UUID: the tool argument and the Contexts page key may differ in case.
    const contextId = call.contextId.toLowerCase()
    const read = reads.get(contextId)
    reads.set(contextId, read
      ? { ...read, calls: read.calls + 1, last_record_id: record.id, last_read_at: record.created_at, state: record.state }
      : { context_id: contextId, calls: 1, first_record_id: record.id, last_record_id: record.id, last_read_at: record.created_at, state: record.state })
  }
  return [...reads.values()]
}

// The Contexts a `context_dirty` activity record announced: the controller
// appends it before a request compiles, and the compiler replays the same list
// upstream as a developer message.
export function contextDirtyContexts(record: HistoryRecord): string[] | null {
  const payload = historyPayloadObject(record.payload)
  if (record.kind !== "activity" || payload?.type !== "context_dirty") return null
  const contexts = Array.isArray(payload.contexts) ? payload.contexts : []
  const ids = contexts.flatMap((context) => {
    const object = historyPayloadObject(context)
    return typeof object?.context_id === "string" ? [object.context_id] : []
  })
  return ids.length > 0 ? ids : null
}
