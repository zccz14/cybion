# Thread View extraction parity

Reference: `bc67cc6` (the parent of the extraction in #697). The component remains the single conversation implementation; the host retains routing, sharing, archive/delete, notes and Manual metadata. No intentional interaction redesign.

## Restored contracts

- Independent React Query reads, original query keys and retries, list-row placeholder, loading/unavailable/history skeletons and local retry controls. Catalog failure cannot block the Thread.
- Original intervals: Thread 1500ms, history 1200ms running / 2500ms idle, response 750ms running and no idle interval. Read/mutation failures are separate.
- Incremental history polling, oldest-first prepend, `has_older` mapping, loaded pages retained across Thread changes, durable-only in-flight call detection. Original scroller and record grouping are unchanged.
- Original mutation invalidations for Thread/list/history/response/audits/Worker calls, saved-title synchronization, per-action pending indicators, draft retention/clearing, text editing during voice recording and disabled text-send during recording.
- Original height, heading, copy/tooltips, empty-state conditions, status/safety/notes/manual panel order, settings availability, API-origin hint and raw-record presentation.
- Historical Manual lookup even after unload, host-router links in both Manual notices and tool cards (including shared Threads), session audio caching.
- Stable transport despite inline token callbacks or host rerenders; host and component share one React Query runtime/cache.

## Verification

`web/e2e/thread-view-parity.spec.ts` was run unchanged against both the reference implementation and the extracted implementation: **11/11 pass on each**. It covers independent loads, three-page history traversal and navigation back, persistent mutation errors and retry, generated-title pending/synchronization, Manual links, immediate live preview/cadence, voice+text submission, control pending state and older-page retry.

The same stubbed conversation was captured on both implementations at 1280×900 and 390×844, after fonts loaded and with animations disabled: **0 differing pixels in both pairs**. This is fixture-scoped visual evidence, not a claim that finite tests prove every possible browser state.

The complete local frontend suite passed: **280 host unit tests, 16 package tests, 164 Playwright tests**, component/host type checks and both production builds. Existing Playwright coverage includes prepend scroll anchoring, streaming handoff, image groups/zoom, record cards, settings, drafts, sharing and mobile layouts. The repository CI runs these again along with backend checks before merge.
