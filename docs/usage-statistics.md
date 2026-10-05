# Usage statistics

`#/insights` is the **Usage statistics** page. It aggregates one user database
over a selected time range (24 hours, 7 days, 30 days, or all time) with
optional model and request-kind filters.

The page combines several questions with deliberately different scopes:

| Section | Answers | Rows counted |
| --- | --- | --- |
| Token usage, By model | How much usage did model requests consume? | `reasoning_audits` started in the range, grouped by model and reasoning effort |
| Time attribution | Where did Thread running time go? | Runs that started in the range |
| Worker calls | How long did Worker calls take, and how much did they transfer? | `worker_calls` created in the range |
| Protocol history | How much history is stored? | `history_records` created in the range |

## Durations

Every duration is the difference between two stored Unix-second timestamps.
Durations are reported, never measured live.

- **Inference duration** — `finished_at - started_at` of a reasoning audit.
  Retries, compaction, and failed requests that recorded an end are included.
- **Worker call duration** — `completed_at - created_at` of a Worker call:
  queueing, delivery, execution on the device, and result upload.
- **Thread running time** — from the run's input (or thread-control) record to
  its last settled timestamp. The latest run of a still-running Thread is
  clipped at the aggregation time.

## Time attribution

A run starts at an `input` record or a `thread_control` activity record
(continue or compact). It ends at the maximum `finished_at` / `completed_at`
of the audits and Worker calls that reference that record; the idle time
between runs is not counted.

Within a run, three parts partition the wall-clock time:

1. **Inference** — the union of the run's audit intervals. Inference wins
   overlaps: a Worker call that starts while the model stream is still open is
   inference time until the model settles.
2. **Worker calls** — the union of Worker call intervals that lie outside the
   audit intervals. A `bash` command killed by its `timeout_seconds` ends its
   Worker call interval at the kill.
3. **Cybion overhead** — the remainder: controller wake-up, tool dispatch and
   settlement, worker-tool `delay_seconds` delays, retry backoff, and other
   processing that is neither a model request nor a Worker call.

The section follows the time range and thread filters only. The model and
request-kind filters do not apply, because one run can contain compaction and
retry requests that have no single model or kind. Overlapping Worker calls
(dispatched together, executed by different Workers) contribute their combined
wait once, not once per call.

## Reasoning effort

`reasoning_audits.reasoning_effort` records the effort that produced the
request (`none`…`max`), or `NULL` when the request carried no effort, for
example title generation and compaction. Requests recorded before the column
existed display `—`.

The By-model table groups rows by model and reasoning effort, and the
Reasoning audit page shows the recorded effort next to every request.

## Daily active Threads

The page also exposes a daily activity calendar. A Thread is **active on a day**
when that UTC calendar day contains at least one `history_records` row for the
Thread whose `kind` is not `checkpoint`. Checkpoint-only maintenance does not
make a Thread active. The heatmap reports the distinct active Thread count for
each day and keeps empty days in the calendar so gaps remain visible.

The heatmap buckets are UTC (`YYYY-MM-DD`). The activity calendar includes the
**whole first UTC day** touched by the selected time range. Model and
request-kind filters do not change it.
