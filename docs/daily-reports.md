# Daily reports

Daily reports are saved AI summaries of one user's retained activity on a UTC
calendar date. Open **Usage statistics**, select a calendar day, and explicitly
choose **Generate / update report**. A day is active when at least one retained
history record is not a checkpoint; creating or renaming an empty Thread does
not count.

## Two aggregation levels

1. **Thread × UTC day**: goal, progress/outcomes, decisions, unfinished work and
   next steps. The source is that Thread's retained non-checkpoint records on
   the selected date, including user input, assistant output, tool output and
   activity records.
2. **Daily report**: completed work, decisions, work in progress, and
   blockers/next steps, grouped by topic across current Thread-day summaries.
   Each daily version identifies the exact child summary versions used.

Deterministic database metrics are displayed separately. An input requesting a
release is not evidence that the release happened. The latest-input excerpt is
explicitly labeled as an excerpt, not an AI summary.

Today's report is provisional. A later record can make it stale; nothing
regenerates automatically. Weekly/monthly reports, schedules and notification
delivery are outside this increment.

## Generation and cost

- The **personal default upstream and model** are used, never an implicit
  fallback to an individual Thread's model. Configure defaults in Personal
  settings before generating. The requested output language is English or
  Simplified Chinese, matching the UI language at generation time.
- GET, page load, refresh and polling only read state. POST explicitly starts
  generation. A detached job continues after the page is closed.
- At most one report job runs per account. A duplicate active request for the
  same date, Thread scope and language returns the existing job; a different
  request receives HTTP 409.
- Generating the whole day first saves individual Thread summaries, then
  composes the daily report. A Thread failure does not erase other successes.
  The daily step requires every active Thread's summary to match its current
  source snapshot.
- Retry is manual. Whole-Thread successful results are reused; partial chunk
  work is not cached. A retry can therefore incur new model charges for a
  previously failed Thread. There is no automatic model-failure retry.
- Usage is stored per report model call in `report_requests`, separately from
  Thread `reasoning_audits`. Known tokens are retained even if final JSON or
  citations fail validation. Missing usage (including a stream that fails
  before a usable terminal response) is explicitly counted, not estimated as
  zero. Network bytes still belong to the account's upstream-traffic counters.

## Evidence and limits of verification

Every nonempty generated item cites original history record IDs. Links open the
existing owner-scoped history inspector. Source manifests record exact IDs,
kinds and timestamps, plus child version IDs for a daily aggregate.

The server checks JSON structure, required section keys, item lengths and that
citations belong to the supplied evidence. It does **not** prove that the prose
is factually supported by the cited text. AI-generated claims need inspection;
provenance is not human verification. Historical assistant assertions and tool
output are not automatically proof of a real-world outcome.

The last pre-day user input can be included as background, up to 4096
characters, but cannot be cited as same-day evidence or counted as that day's
accomplishment. Binary images/files and encrypted reasoning have explicit
omission markers rather than being interpreted as text; inspect the original
record for those materials. Pasted image data URLs project the same way. Worker screenshots are identified by the call
ledger, including Base64 carried inside serialized tool output. Ordinary bash
stdout is not classified as an image by size or appearance. Textual payloads are fragmented rather than
silently truncated. Summaries remain selective condensations, not a guarantee
that every source fact is repeated.

The model receives historical material as untrusted evidence. Requests carry
no tools and `tool_choice: none`; unexpected returned tool items fail the
summary. Report requests have no Thread audit/identity/turn-state context and
cannot append Thread history, execute Worker actions or send task
notifications. The prompt also forbids credential reproduction; this is a
model instruction, not a deterministic secret-redaction guarantee. Generating
necessarily sends the selected textual evidence to the configured upstream.

## Versions, cache and deletion

Schema 18 adds `report_jobs`, `report_summaries` and `report_requests` without
replacing existing Threads or history. Completed and failed summary attempts
are retained as versions; only an in-flight attempt is updated to its terminal
state. A newer failure keeps the previous successful content visible.

A fingerprint covers the date, UTC scope, Thread/title, exact source manifest
and prompt version. Cache matching additionally requires the same model,
upstream ID and URL, and language. Only the latest completed version is eligible
for reuse, so an older-language/model version cannot silently replace the
currently saved version. Credentials are never part of the public report
metadata; rotating a key alone does not invalidate a successful summary.

Fingerprints rely on the append-only history contract: they identify records
by ID/kind/timestamp rather than hashing full payloads. Renames, new/deleted
records, prompt changes and changed child versions cause staleness. Sources
are read from a captured snapshot; activity arriving during generation is not
silently folded into it. The result may instead be marked stale.

Deleting a Thread cascades its summaries and deletes daily summaries derived
from dates with that Thread's summaries. Owner-scoped version and evidence
endpoints never read another user's database. Controller restart marks running
jobs, attempts and calls as failed while preserving completed content; retry
remains explicit.

## Bounded work

| Boundary | Limit |
| --- | --- |
| Raw retained payloads per Thread day | 16 MiB; larger input fails explicitly |
| Textual fragment | 16 KiB (UTF-8 boundaries preserved) |
| Packed evidence per model call | 192 KiB, plus bounded instructions/background |
| Initial chunks per summary | 64 |
| Model calls per summary / per job | 128 / 256 |
| Requested maximum output tokens per call | 16,384 (provider must honor the request) |
| Validated summary JSON | 16 KiB |
| Items per section / characters per item | 8 / 500 |
| Original record citations per item | 1–8 |
| Request / whole-job deadline | 180 seconds / 30 minutes |

Large inputs use bounded chunk summaries and reduction; no source records are
silently discarded to fit the budget. If a limit is reached, the attempt fails
clearly and already completed Thread summaries stay reusable. Empty sections
are allowed when no supported item can be extracted. The UI polls running
jobs every 3 seconds and idle selected dates every 30 seconds.

## HTTP API

All routes require browser authentication and operate only on its user's
SQLite database.

- `GET /api/reports/daily?date=YYYY-MM-DD` returns deterministic metrics,
  per-Thread `daily_summary`, aggregate `summary`, and `generation` state.
- `POST /api/reports/daily/{date}/generate` with
  `{ "thread_id": null, "language": "zh" }` returns HTTP 202 and a job.
  `null` generates the whole day; a Thread UUID generates only that Thread.
  Empty days, malformed dates and future generation are rejected.
- `GET /api/reports/summaries/{id}` returns a retained version and its source
  manifest, model, prompt version, usage and timestamps.

`SummaryState` contains `latest`, `saved` (latest successful version), and
`stale`. The version inspector exposes the child summaries used by a daily
report. There is no general historical-version picker in this increment.

## Validation record

The automated suite covers isolation/authentication, full UTC-day boundaries,
additive schema upgrade, read-only GET, duplicate/concurrent requests, source
changes during generation, persisted versions, independent failures/retries,
cache configuration changes, invalid citations, binary projection/input
limits, tool rejection, restart recovery, streamed completion, and account
traffic attribution. Browser fixtures cover progress/reload, retained
successful output, evidence navigation, date/account isolation, network
recovery and bilingual narrow light/dark layouts.

A bounded synthetic-only trial on 2026-09-28 made three calls to the configured
real upstream (two Thread summaries and one daily aggregate). The outputs
passed structural/citation checks and manual inspection: deployment failure
remained a blocker, planned weekly/monthly work was not presented as completed,
and the injected instruction was not executed or reproduced as a secret. This
is a small prompt/transport check, not an evaluation of all real user data.

A local debug-build read/serialization probe included 100 retained Threads,
20 active Threads and persisted summary manifests. It measured 10k/20k/40k/80k
retained records (2k/4k/8k/16k daily records) in 66/127/269/624 ms respectively;
the largest JSON response was 3.35 MB. **Performance gate: PASS** for the tested
80k-record target with a 3-second budget. The endpoints are short batch reads;
per-row instrumentation would distort their duration. These four bounded
samples show roughly linear growth (endpoint power exponent about 1.08); this
is not a production latency guarantee. Full source manifests make large
responses costly, so raw-manifest rendering is lazy and idle polling is slower.

Run the opt-in probe with:

```sh
cargo test --locked daily_report_retained_history_probe -- --ignored --nocapture
```

A read-only production-size probe before release found Thread-day payloads up
to 5.66 MB and 157 initial chunks at the original 48 KiB request width. That
initial 32-chunk budget would have rejected useful retained days, so delivery
was held. The final request width is 192 KiB with 64 initial chunks (128 calls
per summary, 256 per job), plus explicit Worker screenshot projection. A >6 MB
text fixture checks that the final source tail reaches a leaf call. Context
limits still depend on the selected model: a provider can reject a large
request, in which case the attempt fails visibly rather than dropping evidence.

With the final projection/width, the same read-only probe covered all active
Threads on 2026-09-26/27/28: maximum initial chunks per Thread were 11/30/33;
none exceeded 64. Conservative worst-case call counts (including reduction
and the daily aggregate) were 67/192/69, within the 256-call job budget. A fourth
synthetic-only real-upstream request used 161,245 bytes of evidence (34,657
reported input tokens), completed in 12.79 seconds, passed validation, and
cited the final source record. This checks one large call, not full-day
inference latency: a busy day can still exceed the 30-minute deadline and
require a manual retry to reuse already completed Thread summaries. No
full-history model sweep or real-user-day generation was performed for these
probes.
