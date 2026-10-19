import { cybionToolFunctionCall } from "./history-payload.ts"
import type { HistoryRecord } from "./thread-history.ts"

// One `read_context` call the Thread made inside the context it still replays,
// with the fingerprint of the version it answered with and of the same read now.
export type ThreadContextReadCall = HistoryRecord & {
  read_hash: string | null
  current_hash: string | null
}

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
  // The version this Thread read; null when the model never received a body.
  read_hash: string | null
  // What the same read returns now; null when the Context no longer resolves.
  current_hash: string | null
}

export type ContextReadState = "current" | "changed" | "unanswered" | "missing"

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
      ? { ...read, calls: read.calls + 1, last_record_id: record.id, last_read_at: record.created_at, read_hash: record.read_hash, current_hash: record.current_hash }
      : { context_id: contextId, calls: 1, first_record_id: record.id, last_record_id: record.id, last_read_at: record.created_at, read_hash: record.read_hash, current_hash: record.current_hash })
  }
  return [...reads.values()]
}

export function contextReadState(read: ThreadContextRead): ContextReadState {
  if (read.read_hash === null) return "unanswered"
  if (read.current_hash === null) return "missing"
  return read.read_hash === read.current_hash ? "current" : "changed"
}

// The Contexts page addresses a Context by its full id and the endpoint answers
// full fingerprints; the Thread page shows the short form of each so a row of
// chips stays readable.
export function shortContextId(contextId: string) {
  return contextId.slice(0, 8)
}

export function shortFingerprint(hash: string) {
  return hash.slice(0, 8)
}
