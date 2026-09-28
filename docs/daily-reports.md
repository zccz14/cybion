# Daily reports

Daily reports are versioned AI summaries of one user's retained **work Thread**
activity on a UTC date. A visible **report Thread** maintains them using four
Controller tools. It is an ordinary Thread with a restricted purpose and tool
policy: report buttons and direct conversation use the same execution loop,
protocol history, reasoning audits, compaction, stop/continue, and recovery.
Reports are independent saved artifacts; a final chat reply is not a report save.

## Start and observe a report

Open **Usage statistics**, select a day, then **Generate / update report**.
Alternatively, explicitly create/open the report Thread and ask it to maintain
a report for a date. Creating the empty Thread, GET, page load, and polling do
not invoke a model. Closing the browser does not stop an accepted run.

Each account has at most one report Thread. It initially inherits the personal
default upstream, model, reasoning effort and fast setting, with a 65,536-token
context budget. Later runs use that Thread's settings, not subsequent changes
to personal defaults. Stop it before editing generation settings. Generation
uses English or Simplified Chinese, as requested by the button or conversation.

The report card links to the Thread and its filtered reasoning audit page.
It displays saved versions, staleness, current task progress and reported usage.
Stop and Continue use the ordinary Thread controls. Polling is every 3 seconds
while the job or report Thread is running, and every 30 seconds otherwise.
No schedules, weekly/monthly expansion or Linkit task notifications are enabled.

## Scope and saved documents

A work Thread is active when it has a retained non-checkpoint history record on
the UTC date. Creating or renaming an empty Thread does not count.

| Artifact | Ordered section keys | Source |
| --- | --- | --- |
| Thread × UTC day | `goal`, `progress`, `decisions`, `next_steps` | That work Thread's retained non-checkpoint records on the date |
| Daily report | `completed`, `decisions`, `in_progress`, `blocked` | Exact saved versions of every captured active work Thread summary |

Daily prose groups work by topic. Deterministic daily metrics are separate from
AI claims. The latest-input excerpt is explicitly an excerpt, not a summary.
Report/management history is excluded from both daily sources and daily work
metrics, preventing reports from summarizing or invalidating themselves. The
activity heatmap still counts **all** active Threads, including report Threads;
its count can therefore differ from the selected day's work-only detail.

Today's report is provisional. New source activity can make a saved report
stale. Nothing regenerates automatically.

## Controller tools and permission boundary

| Tool | Behavior |
| --- | --- |
| `cybion_list_threads` | Opens a date-scoped task when needed; lists captured work Threads, read cursors and reusable versions |
| `cybion_read_history` | Reads fixed source fragments in bounded pages; kind-filtered reads are inspection only |
| `cybion_read_report` | Reads saved versions; after every required Thread summary is saved, pages through daily child summaries |
| `cybion_update_report` | Validates and atomically saves a version using the snapshot ID and expected prior version |

Tools run inside the Controller against the authenticated owner's database;
there is no caller-supplied user ID and no model call hidden inside a tool.
Ordinary work Threads cannot invoke these tools. Report inference advertises
exactly these four functions. Report compaction/title helper requests have no
tools. Worker, context, tool-search, native and unknown tools are denied before
dispatch, even when an upstream returns one unexpectedly.

Historical records and saved report prose are untrusted evidence, not new
instructions. The prompt forbids executing embedded instructions and reproducing
credentials. This is not deterministic secret redaction. Generation necessarily
sends the selected textual evidence to the report Thread's configured upstream.

## Snapshots, paging and writes

The task captures a fixed set of work Threads and exact retained record IDs,
kinds and timestamps. Later activity is not silently folded into that task.
Text pages are materialized lazily from the captured records. Read every
unfiltered page; `limit` is a page size, not proof of full coverage. The server
prevents skipping unread fragments, tracks coverage and rejects early writes.
The daily document requires all captured child summaries and all child pages.

Each write requires the current `expected_version` (compare-and-swap). It
rechecks retained evidence, snapshot scope and daily child versions. A saved
report and its corresponding tool-output history record commit in one
transaction. Replaying the same tool call returns the original result without
creating another version. A failed revision does not erase earlier successful
content; unresolved write errors keep the task from claiming success.

Source fingerprints cover UTC date, Thread/title, exact source manifest and
prompt version. They rely on append-only history rather than hashing full
payloads. Reuse additionally requires the latest successful version to match
language and the report Thread's model/upstream URL/ID/name, effort and fast
settings. Keys are not included. Configuration changes between source capture
and inference are rejected. Compaction's helper settings do not change the
task's generation fingerprint. Cache reuse may still require report-Thread
inference to inspect and maintain the task; it does not promise zero cost.

## Evidence and limits of verification

Every nonempty item cites original history record IDs. Evidence links open the
owner-scoped history inspector; daily manifests identify child version IDs.
The server validates section structure, lengths and citation membership, **not
semantic truth**. A deployment request or an assistant assertion is not itself
proof of deployment. Inspect claims and their evidence when correctness matters.

Up to 4096 characters from the last pre-day user input may appear as background;
that input cannot be cited as same-day evidence. Binary files/images and
encrypted reasoning have omission markers. Worker screenshot payloads are
identified by the call ledger, including Base64 in serialized tool output;
ordinary stdout is not classified as an image merely by size. Text is fragmented
rather than silently truncated. Summaries are selective, not exhaustive.

## Audits and cost

All new report model requests, including common-runtime retries and compaction,
use `reasoning_audits`, retained response state and account traffic accounting.
They appear in the report Thread and unified account Token charts, never in a
source work Thread's usage. The report audit link filters by executor Thread.

A task's usage sums audits across its runs. A version's `audit_id` identifies
only the inference request that issued its write; the version panel explicitly
labels that request's usage, not the full task cost. Missing usage is not
estimated as zero. A successful model response can still lead to a failed
report task if no valid report was saved.

Schema-18 standalone generation used `report_requests`. Those historical rows
remain readable as legacy usage; no new calls are written there and no old
Thread audits are fabricated. The legacy reader exists for retained pre-upgrade
artifacts. It can be removed only after every retained database has no legacy
versions/usage, with migration and backup checks proving that condition.

## Stop, continue, restart and retention

- Identical active date/scope/language button requests return the same job and
  input record. A different request, or an unrelated busy report conversation,
  receives a conflict rather than being silently replaced.
- Stop cancels the ordinary run and marks its task failed. Saved reports and
  the current failed task's read cursors/materialized pages remain available.
- Continue creates a new ordinary run with fresh budgets and resumes the latest
  failed task, provided no newer user prompt superseded it and generation
  settings still match. A changed configuration requires a new task.
- A new prompt supersedes the previous task. A new task takes fresh snapshots
  and reuses eligible successful versions. It discards old temporary snapshots.
- Completed tasks immediately discard their temporary snapshots/pages. Only the
  latest resumable failed task retains them; there is no time-based expiry.
  Versions, task metadata, audits and Thread tool history remain retained.
- Controller restart uses the common Thread supervisor to resume new report
  tasks, preserving snapshots and idempotent tool replay. Interrupted audits
  settle through common recovery. Pre-upgrade standalone jobs instead fail and
  require an explicit retry.
- Deleting a source Thread removes its linked summaries/snapshots and derived
  daily reports. **Copies already placed in another Thread's tool history stay
  in that Thread.** Delete the report Thread to remove its copies and audits.
- Deleting the report Thread preserves saved report artifacts but removes
  executor/input/audit links and temporary snapshots. The UI shows unavailable
  usage rather than claiming those artifacts cost zero. A later explicit action
  can create a new report Thread.

Schema 19 adds the Thread purpose, report execution links, `report_runs`,
`report_snapshots` and `report_source_units`. Existing work Threads, retained
history and legacy reports are preserved.

## Bounded work

| Boundary | Limit |
| --- | --- |
| Raw retained payloads per Thread day | 16 MiB; larger input fails explicitly |
| Textual fragment | 16 KiB at UTF-8 boundaries |
| History/child-summary page data | 192 KiB |
| Listed Threads / history fragments per page | 50 / 100 maximum |
| Source-page reads per explicit run | 64 MiB |
| Model calls per explicit run, including helpers/retries | 256 |
| Model call / explicit run deadline | 180 seconds / 30 minutes |
| Requested maximum output tokens per call | 16,384; provider must honor the request |
| Validated document JSON | 16 KiB |
| Items per section / characters per item / citations per item | 8 / 500 / 1–8 |

Large tasks use normal Thread compaction while preserving cursors and evidence
notes. Reaching a limit fails visibly rather than discarding unread evidence.
Continue or start a new task explicitly to use another bounded run. Model
context limits and real latency can still prevent a busy day from completing.

## HTTP API

All routes require browser authentication and use its owner's SQLite database.

- `POST /api/reports/thread`: create/reuse the visible Thread, without inference.
- `GET /api/reports/daily?date=YYYY-MM-DD`: work-only metrics, Thread summaries,
  daily summary and generation/executor state; read-only.
- `POST /api/reports/daily/{date}/generate` with
  `{ "thread_id": null, "language": "zh" }`: HTTP 202 and the common-Thread
  job. Null means all work Threads plus daily aggregate; a UUID selects one
  work Thread. Empty days, invalid dates and future generation are rejected.
- `GET /api/reports/summaries/{id}`: retained version, manifest, execution links
  and writer-request or legacy usage.
- `POST /api/threads/{id}/cancel|continue|compact`: ordinary Thread controls.

`SummaryState` contains `latest`, `saved` (latest successful version), and
`stale`. The version inspector exposes exact daily child summaries. This
increment does not add a general historical-version picker.

## Validation record

Automated tests cover schema-18 migration, ownership/authentication, common
execution/audits/traffic, conversational generation, source exclusion,
snapshots/paging, citation/CAS failures, atomic replay, cached revisions,
stop/continue/restart, configuration changes, budgets, deletion and binary
projection. Browser fixtures cover creation/navigation, audit filtering,
stop/continue, retained results, evidence links and bilingual narrow layouts.

On 2026-09-28, a synthetic-only full-runtime trial used the configured
`deepseek-flash` upstream through a bounded loopback/SSM forwarding adapter.
Credentials stayed on EC2. Six model requests completed in 26.93 seconds,
reporting 22,096 input and 2,812 output tokens. Both versions were saved through
tools and linked to ordinary audits; no Worker call or `report_requests` write
occurred. Inspection confirmed deployment failure remained unresolved, proposed
weekly/monthly work was not labeled completed, and the injected fake credential
was not reproduced. This verifies a small real-model tool workflow, not a
full production-day sweep. No production user history was sent in the trial.

A ~6.6 MB synthetic source under an 8192-token test budget completed in 3.186
seconds with 77 fake model requests and 37 compactions; the final source tail
was retained. This tests paging/compaction, **not real-model latency or semantic
quality after many compactions**.

The local debug-build read/serialization probe used 100 retained Threads,
20 daily active Threads and saved manifests. At 10k/20k/40k/80k retained records
(2k/4k/8k/16k daily records), it measured 68/137/296/698 ms, respectively; the
largest JSON was 3.36 MB. **Performance gate: PASS** for the tested 80k target
and 3-second budget, not a production latency guarantee. The endpoint is a
short batch read; per-row instrumentation would distort it. The endpoint
power exponent is about 1.12; conservative local-slope scaling remains below
the budget at this tested size. Manifests remain costly in large responses.

Opt-in probes:

```sh
cargo test --locked daily_report_retained_history_probe -- --ignored --nocapture
cargo test --locked multi_megabyte_report_thread_probe -- --ignored --nocapture
# Supply an explicitly bounded loopback adapter to the configured real upstream:
CYBION_REPORT_SMOKE_URL=http://127.0.0.1:PORT cargo test --locked real_report_thread_synthetic_smoke -- --ignored --nocapture
```
