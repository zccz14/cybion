# Ultimate machines

An ultimate machine runs one bash command on a Worker on a fixed interval and
stays silent while the command returns 0. Its only message is a request to fix
what the command reports; in the ideal case it never sends anything.

Each machine owns a browser-created Thread (`终极机器 · <name>`) that the user
can read, configure, and steer like any other Thread.

## Lifecycle

| Event | Behavior |
| --- | --- |
| First run | Starts right after creation — the machine does not wait a full interval. |
| Healthy run | The result updates `last_run_at`/`last_exit`; nothing is sent. |
| Failing run (exit ≠ 0, or killed with no code) | The controller appends a user message to the bound Thread: the command, the exit code, the tail of stderr/stdout, the command intent (an `意图：` section) when one is set, and the success criterion ("make the command return 0"). |
| Thread already running | The failure message is dropped rather than queued (exhaustion semantics); the run after the Thread settles decides again. |
| Worker offline or gone at the scheduled time | The run is skipped and the owner receives one Linkit notification per offline episode; the flag resets when the next run is dispatched. |
| Run never settled (device died mid-run) | After 15 minutes the run is declared failed, the owner is notified once, and the next interval retries. |
| Interval scheduling | The next run starts one interval (seconds) after the previous run settled; at most one run per machine is in flight. |

## Storage

Each machine is one `machines` row in the owner's database:

| Column | Meaning |
| --- | --- |
| `id`, `name`, `command`, `intent`, `interval_seconds`, `created_at` | The machine definition (`intent` optionally describes what the check is for). |
| `worker_id` | The Worker that runs the command; deleting the Worker or the Thread removes the machine. |
| `thread_id` | The bound repair Thread. |
| `enabled` | The pause switch. |
| `last_run_at`, `last_exit` | The latest settled run; `last_exit` is -1 when the command was killed. |
| `offline_notified_at` | Set while an offline notice was sent; cleared by the next dispatch. |

Machine runs are `worker_calls` rows with `machine_id` set. They follow the
normal Worker protocol (`bash`, `timeout_seconds: 300`) but settle through the
machine scheduler instead of a Thread turn, and they are excluded from usage
statistics.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/machines` | List machines with Worker/Thread labels and the latest result. |
| `POST` | `/api/machines` | Create a machine (also creates its Thread). |
| `PATCH` | `/api/machines/{id}` | Partial update with any of `enabled`, `name`, `worker_id`, `command`, `intent`, `interval_seconds`; the pause switch sends `enabled` alone and an empty `intent` clears it. |
| `POST` | `/api/machines/{id}/run` | Run once now (rejected while a run is pending or the Worker is offline). |

Renaming a machine retitles the repair Thread to `终极机器 · <name>` only while
the Thread still carries its automatic title; a hand-renamed title is kept.
Changing `worker_id` clears `offline_notified_at`, so the new Worker starts a
fresh offline episode.

## Page

`#/machines` (Work group) shows every machine with status, Worker, command,
interval, latest result, and a link to its repair Thread, and offers the pause
switch, a one-off run, and an edit dialog that shares the create form (name,
Worker, command, intent, interval). The page polls every 5 seconds.

A `?` button opens a dialog on the origin of the name — the Bell Labs joke box
(Marvin Minsky's 1952 build, whose fame spread from Claude Shannon's desk)
whose only function is to switch itself off — with a small looping animation of
the box doing exactly that.
