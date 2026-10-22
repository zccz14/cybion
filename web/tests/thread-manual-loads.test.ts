import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { manualLoadNotice } from "../src/lib/thread-manual-loads.ts"
import type { HistoryRecord } from "../src/lib/thread-history.ts"

const manual = "8F1D2E3A-4B5C-6D7E-8F90-1A2B3C4D5E6F"
const loaded: HistoryRecord = {
  id: 7, thread_id: "thread", kind: "activity", created_at: 7,
  payload: { type: "manual_loaded", manual_id: manual, fingerprint: "aaaa", manual: { id: manual, name: "必读手册", content: "body" } },
}

test("a loaded Manual travels as its own activity record", () => {
  assert.deepEqual(manualLoadNotice(loaded), { manual_id: manual.toLowerCase(), loaded: true })
  assert.deepEqual(
    manualLoadNotice({ ...loaded, payload: { type: "manual_unloaded", manual_id: manual, reason: "released" } }),
    { manual_id: manual.toLowerCase(), loaded: false },
  )
  assert.equal(manualLoadNotice({ ...loaded, kind: "input" }), null)
  assert.equal(manualLoadNotice({ ...loaded, payload: { type: "thread_control", action: "compact" } }), null)
  assert.equal(manualLoadNotice({ ...loaded, payload: { type: "manual_loaded" } }), null)
})

test("a retired context_dirty record is not a load notice", () => {
  const dirty: HistoryRecord = {
    id: 9, thread_id: "thread", kind: "activity", created_at: 9,
    payload: { type: "context_dirty", manuals: [{ manual_id: manual, read_record_id: 11, current_hash: "aaaa" }] },
  }
  assert.equal(manualLoadNotice(dirty), null)
})

test("the transcript row reads the loaded bindings and nothing re-reads them", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const indicator = readFileSync(new URL("../src/components/thread-manual-loads.tsx", import.meta.url), "utf8")
  assert.match(main, /\/history\/loaded`/)
  assert.match(main, /<ThreadManualLoads view=\{manualLoads.data\}/)
  // The row is a transcript row, not header chrome: loading more Manuals scrolls away instead of shrinking the conversation.
  assert.ok(main.indexOf("<MessageScrollerContent") < main.indexOf("<ThreadManualLoads view="))
  assert.match(main, /<ManualLoadNotice notice=\{loadNotice\}/)
  assert.match(main, /manualLoadNotice\(record\)/)
  // The retired read tool and its stale-copy notices are gone from the client.
  assert.doesNotMatch(main, /read_context/)
  assert.doesNotMatch(main, /history\/reads/)
  assert.doesNotMatch(main, /context_dirty/)
  assert.match(indicator, /view\.loaded/)
  // The row counts against the cap the controller reports, so a Thread that is
  // full reads as full instead of merely long.
  assert.match(indicator, /view\.limit/)
  // The row label already says 已加载手册, so a chip carrying the same badge again is noise.
  assert.doesNotMatch(indicator, /loadedLabel/)
  assert.match(indicator, /text\.unknown/)
  assert.doesNotMatch(indicator, /state\[|fingerprint/)
})
