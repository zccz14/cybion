# Usage statistics

`#/insights` is the **Usage statistics** page. It presents materialized
snapshots of one user database over four fixed ranges (24 hours, 7 days,
30 days, all time) with optional model and request-kind filters.

## Materialized snapshots, not request-time scans

Ad-hoc range queries cannot scale to a large history: even with ideal indexes,
every request would have to walk the rows inside its range, and a statistics
page that polls makes that cost recurring. Usage statistics are therefore
served from **snapshots that a background patrol maintains**; request handling
never reads raw rows.

The data flows through these layers inside each user database:

1. **raw tables** — `reasoning_audits`, `worker_calls`, `history_records`.
   Their write semantics are unchanged.
2. **hour buckets** — `stats_hour_audit`, `stats_hour_worker`,
   `stats_hour_history`: cells aggregated per UTC hour and dimension.
   An hour closes only after it has ended and a safety window passed, and only
   terminal rows fold into it. A row that is not settled yet is remembered in
   `stats_pending` and folded into its own hour once it settles. A late
   mutation to an already-folded row (for example a Worker result that arrives
   after its call folded) enqueues that hour in `stats_dirty_hour`, and the
   patrol recomputes the hour.
3. **totals and days** — `stats_total_*` accumulates hour closures so the
   all-time range stays O(1); deleting a Thread subtracts its folded
   contribution in the same transaction. `stats_day` records per Thread × UTC
   day activity (record counts, inputs, requests, Tokens) and feeds the
   activity calendar.
4. **snapshot views** — `stats_view_totals`, `stats_view_model`,
   `stats_view_worker`, `stats_view_day`: the per-range cells that requests
   read. The patrol rewrites one range's views atomically with a
   `generated_at` timestamp. **Request cost is bounded by the number of
   dimension cells, not by the size of history.**

Freshness is deliberately traded for cost. A read returns the last refreshed
snapshot; the view states the snapshot time, and the page displays it. There
is no read-triggered computation and reads never wait for the patrol.

## The patrol

One in-process patrol walks all user databases on a fixed compute budget. Each
pass:

1. cheaply checks every database for pending work — new rows, hours ready to
   close, dirty hours, backfill below the closed range, and recent readers;
2. processes work in priority order: (1) fold fresh data and corrections,
   (2) refresh the views of databases that were read recently, (3) backfill
   deeper history;
3. stops when the pass budget is exhausted.

The pass interval and per-database batches are sized so the patrol stays a
low-load background; databases without work cost a few O(1) probes per pass.
The key constraint is that a finite compute budget serves an arbitrarily large
work backlog: task latency is not important, so nothing is ever skipped —
only deferred. When a deployment grows, concurrency across databases scales
with the number of databases that have work, and the budget can be raised
administratively when freshness truly matters to someone.

Reading a snapshot marks the database "recently read". That only raises its
refresh priority on the next pass; it never triggers synchronous work.

## Backfill

A database that predates this feature backfills in the background. Recent
hours close first, so the 24-hour, 7-day and 30-day ranges become exact within
the first passes; the patrol then proceeds downward until all of history is
covered. Snapshots report `backfilling` until the oldest hour is closed, and
the page can note that history is still filling in. Backfill never blocks
requests. A database that starts fresh under this feature has nothing to
backfill; its hours close as time passes.

## Sections and their sources

| Section | Answers | Snapshot source |
| --- | --- | --- |
| Token usage, By model | How much usage did model requests consume? | `stats_view_model` (range × model × reasoning effort × request kind, with status counts) |
| Request outcomes | What happened to requests? | `stats_view_totals` |
| Worker calls | How long did Worker calls take, and how much did they transfer? | `stats_view_worker` (range × worker, durations, read/write bytes) |
| Protocol history | How much history is stored? | `stats_view_totals` (records, payload bytes, checkpoints, latest record) |
| Daily activity | Which Threads were active? | `stats_view_day` for the range's UTC days |

Model and request-kind filters narrow the model and Worker sections. A Worker
call is attributed to the audit that dispatched it — the earliest audit on its
`(thread_id, input_record_id)` — so a filtered read counts each call once and
no fingerprinting heuristic is involved.

## Durations

Every duration is the difference between two stored Unix-second timestamps;
durations are reported as folded, never measured live.

- **Inference duration** — `finished_at - started_at` of a reasoning audit,
  including retries, compaction, and failures that recorded an end.
- **Worker call duration** — `completed_at - created_at` of a Worker call:
  queueing, delivery, execution on the device, and result upload.

## Daily activity

The activity calendar is a UTC calendar over the selected range, built from
`stats_view_day`. A Thread is **active on a day** when that UTC day contains
at least one `history_records` row for the Thread whose `kind` is not
`checkpoint`. Checkpoint-only maintenance does not make a Thread active. The
heatmap reports the distinct active Thread count for each day and keeps empty
days in the calendar so gaps remain visible. The calendar counts all purposes.
Model and request-kind filters do not change it.

## Removed in this rebuild

- **Time attribution** (the inference / Worker / Cybion overhead split) is
  removed. Interval union and overlap subtraction are not additive across
  buckets, so the section could not be served at O(1) read cost, and it served
  operator forensics rather than usage accounting.
- **Daily reports** (AI Thread-day summaries and report Threads) are taken
  offline pending a future redesign. Existing stored artifacts and report
  Threads are retained untouched; nothing generates new reports.
