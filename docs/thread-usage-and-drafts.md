# Thread usage and composer drafts

Thread lists and conversation headers show cumulative reported Token usage and
an input-weighted cache rate. Unsent composer text is saved in this browser,
independently for each account, thread, and the new-thread page.

## Token accounting

Each Thread API view includes `usage`:

| Field | Meaning |
| --- | --- |
| `input_tokens` | Sum of reported input Tokens across this thread's retained audits |
| `output_tokens` | Sum of reported output Tokens |
| `total_tokens` | Input + output; cached input is not added again |
| `cached_tokens` | Sum of reported cached input Tokens |
| `cache_hit_rate` | Cached input / input, as a fraction from 0 to 1; `null` when unavailable |
| `unreported_requests` | Number of audits with missing input or output usage |

All request kinds and statuses are included: inference, compaction, title
creation, retries, and failed/cancelled requests with reported usage. Request
status is not a substitute for whether Tokens were consumed. Each audit row is
counted once; updating its streaming/final state does not add a second copy.
This is reported usage, not a billing estimate or current context length.

SQL sums known values. Missing values are not estimated. An audit with missing
input/output raises the incomplete-usage indicator, including a running request
that has not reported usage yet. The count can remain nonzero after a failed
request if the upstream never reports its usage.

Cache rate uses sums, not an average of request percentages. Fully unreported
requests are outside the reported totals. A reported positive input count with
missing cache details, or a cache count without its corresponding input count,
makes the aggregate rate unavailable (`—`). A known zero cache count with positive
input is `0%`; no input is `—`. The tooltip explains this distinction and the
cumulative scope.

## Presentation and refresh

- Each thread row shows compact cumulative Tokens and cache rate. Its keyboard/
  hover tooltip includes exact counts, the input/output/cache breakdown, and scope.
- The conversation header shows exact cumulative Tokens and cache rate. A native
  disclosure opens the same breakdown on keyboard, pointer, or touch input.
- The open thread's list row and header use the same detail snapshot.
- The existing list/detail polls refresh these metrics when audits are saved.
  The browser does not add streaming previews to the persisted totals.
- New threads show zero Tokens and `—` cache rate. Changing model, renaming,
  stopping, continuing, or compacting does not reset accumulated usage.
- Existing audit history is used immediately; no counter backfill, schema
  migration, extra per-thread HTTP call, or second stored total is introduced.

## Query scope and performance

The list query joins one grouped audit aggregate. Single-thread reads put the
thread filter **inside** that aggregate, using the existing
`reasoning_audits_thread_started` index; they do not aggregate all other threads.
Thread metadata, display status, and usage come from one SQLite statement.
Database ownership remains the existing per-user database boundary.

A bounded in-memory SQLite probe on MacMini used 100 threads, three measured
samples, three repetitions per query, and a 30-second VM deadline. Independent
Python sums matched the query's canonical integer output byte-for-byte.

| Audit rows | List median | One-thread median |
| ---: | ---: | ---: |
| 10,000 | 1.825 ms | 0.026 ms |
| 100,000 | 19.194 ms | 0.219 ms |
| 200,000 | 38.324 ms | 0.410 ms |

Performance gate: **PASS** for the observed 200,000-row/100-thread target, against
200 ms list / 10 ms detail budgets. The measured list scaling exponent was 1.018;
the target is the largest measured sample, so no larger-scale extrapolation is
claimed. This is a synthetic local probe, not a production latency guarantee.
The batch-only probe uses a SQLite VM callback for a deadline; no production
instrumentation or speculative denormalized counters are needed.

## Draft ownership and persistence

Storage keys use the verified `/api/me` user ID plus either a Thread ID or the
separate new-thread scope. `/threads` and `/threads/new` share that new-thread
draft. An account is resolved before any composer is mounted. The workspace is
keyed by user ID and conversation components by route so a late submission keeps
its source draft identity.

- Store the exact text synchronously on each input change, including newlines
  and surrounding whitespace. There is no debounce window that a refresh can lose.
- Save in `localStorage` in the current browser profile. Drafts are not sent to a
  server, are not cross-device synchronization, and remain after navigation/reload.
- A successful server acknowledgement clears only the submitted raw text if the
  stored draft is still the same. Failed sends leave the draft intact. A newer
  edit and other thread/new-thread drafts are never cleared by that acknowledgement.
- Explicitly emptying a composer and successful deletion of its thread remove
  that draft key. Clearing browser storage also removes drafts.
- Browser storage events synchronize matching keys between tabs. A scoped local
  event also updates a composer reopened in the same window while a send was in
  flight. Concurrent edits use the last stored text; there is no collaborative merge.
- Storage failures keep the current input editable in memory and show a warning
  to copy it before leaving/reloading. The UI does not claim that failed writes
  were persisted.
- Worker-provided initial text seeds an empty new-thread draft, preserving an
  existing nonempty draft. Consume the navigation prefill state once so Back or
  Refresh cannot resurrect a successfully sent instruction.
- Per-call new-thread navigation only occurs while its originating composer is
  still mounted; a late acknowledgement does not redirect a different active page.

## Validation and complexity

Backend tests cover weighted sums, request kinds/statuses, partial reports, zero
input, cross-thread/user isolation, repeated audit updates, large counts, rename,
status changes, and deletion. Frontend/browser tests cover exact/compact usage,
unknown versus 0%, narrow bilingual themes, draft ownership, refresh, failure,
late acknowledgements, prefills, storage failure, and cross-tab updates.

Necessary new paths are limited to missing usage / zero denominators, the
verified-owner loading/error boundary, and draft lifecycle rules (empty scope,
conditional clearing, key-filtered notifications, storage-error recovery).
Storage errors use a real in-memory fallback with a visible warning. There are
no new compatibility paths, schema migrations, or inference-control changes.
