# Administrator users: running Threads

`#/admin/users` lists every user database with its usage, traffic and the
**Running** column: how many Threads are executing right now and which party
owes each one's next step. The three phases always add up to the running
total, because every `status='running'` Thread lands in exactly one of them.

## Phases

| Phase | Who owes the next step | Examples |
| --- | --- | --- |
| `inference` | The upstream inference API | One model request, including context compaction and retry attempts |
| `device` | The user's device (a Worker) | `bash`, `browser_control`, `computer_use`, `view_image` — queued for pickup or executing |
| `kernel` | This Controller | Controller tools, context compilation, retry backoff, `delay_seconds` waits, persistence and finalization |

`threads.status='running'` is the execution switch and already means "the
Controller should keep advancing this Thread, including tool waits and retry
backoff" ([Thread status](thread-status.md)); the column splits that set, it
does not redefine it.

## Which tool belongs to which phase

`tools.json` is the single source: it groups every tool by the party that
executes it.

- `worker` → `device`.
- `context` and `native` → `kernel`. The native tools (web search, image
  generation) are intercepted in `start_response_tool` and executed by the
  Controller against the Thread's upstream, so the upstream never owns that
  wait, and the Tools page lists both groups as one Kernel group.

`run_phase::tool_phase` implements the mapping and a unit test fails the build
when a catalog tool has no phase. A native tool executed server-side by the
upstream in the future would belong to `inference` instead, so the rule is
"who executes it", not "which vendor publishes it".

Two consequences worth stating:

- A `delay_seconds` Worker call is `kernel` until the Controller hands it to
  the device, because the Controller owns that timer.
- An Ultimate Machine run is dispatched by the machine scheduler, not by a
  Thread turn, so it is never counted here.

## One live phase per Thread

Each live run keeps a phase cell in the entry `active_requests` already holds
(`user:thread`), and the turn writes it at every boundary: request start and
each loop iteration (`kernel`), retry waits (`kernel`), the model request
(`inference`), Controller-executed tools (`kernel`, restored to the previous
phase afterwards) and Worker waits (`device`). Every write is fenced by the
request record id, so a superseded task cannot repaint a newer request.

The durable rows stay the independent evidence. When a running Thread has no
live phase — the restart window before the supervisor resumes it, or a Thread
this Controller could not resume at all — the snapshot falls back to:

- an `in_flight` inference/compaction audit → `inference`;
- an unsettled local `worker_calls` row → `device`;
- a pending shared-device intent (`history_records` with an owner and no
  output phase) → `device`;
- anything else → `kernel`.

A missed phase write therefore degrades to evidence instead of a wrong answer,
and `unattended` counts the running Threads with no live run. One scan can miss
a Thread that just started or just finished, and a restart re-registers every
run within five seconds, so the count only includes Threads that have been
without an executor for 30 seconds: seeing it above zero means recovery is not
resuming them.

## Cost

Each poll (every 5 seconds) opens each user database read-only and answers two
questions, neither of which depends on how much history the user has:

- **Usage counters** (requests, tokens, cache rate, history records, Threads,
  Workers) come from the single `user_rollup` row the database maintains for
  itself. Seven integers, no table scan.
- **Running Threads** are bounded by the running set: in-flight audits and
  unsettled Worker calls are reached through their status-prefixed indexes, and
  pending shared intents through the partial `history_shared_intent_thread`
  index.

The page never scans a history range and keeps no time series, so it stays a
snapshot rather than the interval attribution that usage statistics removed
(see [usage statistics](usage-statistics.md)).

### The usage rollup

`user_rollup` holds one row per user database. Triggers on `reasoning_audits`,
`history_records`, `threads` and `workers` adjust it inside the same
transaction as the write that changed a raw row, so the row is exact at every
commit — including the foreign-key cascade behind `DELETE FROM threads`, which
fires the child tables' delete triggers. Soft-deleting a Worker moves `workers`
by the same trigger rule the page reports.

The triggers make a table structural change fail while they are attached
(SQLite validates trigger bodies when a column is dropped), so
`migrate_user_schema` detaches them first, rebuilds whatever it needs, then
recreates them and recomputes the rollup from the raw rows. That recompute also
seeds a database created before schema 46, so the counters need no separate
backfill step. A failed migration rolls back with the old triggers intact.

Reads fall back to counting the raw rows when `user_rollup` is absent — a file
no Cybion build has migrated yet — and the regression test keeps both answers
equal.

## API

`GET /api/admin/users` returns the aggregate and per-user `running` object:

```json
{
  "generated_at": 1761000000,
  "running": { "total": 12, "kernel": 2, "inference": 6, "device": 4,
               "unattended": 1, "longest_seconds": 252 },
  "items": [{ "user_id": "…", "metrics": { "running": { "total": 3, "…": "…" } } }]
}
```

`longest_seconds` is the age of the oldest Thread in its current phase.
`unattended` is orthogonal to the phases: it flags running Threads without a
live run and does not move them out of their phase.

## Assumptions

- One Controller process per installation: a live run always has an entry in
  `active_requests`, so "running without a live phase" means "no executor".
  A multi-process Controller would have to disable `unattended`.
- Phases are observation state. Nothing decides behaviour from them, and no
  schema column, background task or history row is added.
