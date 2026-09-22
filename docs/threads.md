# Thread model

Every conversation is an independent thread owned by one Auth Mini user. A
thread is identified by a time-ordered UUID v7 and carries a title, model,
reasoning effort, Fast mode, status, timestamps, and an append-only history.
Inference requests always include the provider-native `web_search` and
`image_generation` tools. Users and API clients can append input to any thread
they own.

```text
user database
  └── thread
        ├── metadata
        └── history_records (ordered by id)
```

An input record is written before inference begins. Responses output items and
Worker results are appended as they arrive, so a later request can reconstruct
the thread from durable records after a process restart. A context checkpoint
is another history record; it summarizes an earlier prefix without removing
the source records.

The UI exposes `idle`, `running`, and `failed` thread states. Failures append
an activity record and leave the thread ready for a later input.

The composer also offers **Stop**, **Continue reasoning**, and **Compact**:

- Stop cancels the current model request and prevents further inference or
  Worker dispatch for that request. Completed history records stay unchanged.
  Already dispatched Worker actions may finish; their late results are kept as
  activity and cannot restart reasoning. The thread returns to `idle`.
- Continue reasoning starts from the latest saved protocol record without
  appending a user message or sending a synthetic prompt. New outputs are
  appended to the same thread. The composer draft is retained.
- Compact creates a validated checkpoint from the current context, preserves
  all source records, and returns to `idle` without resuming inference. The
  next continuation starts from that checkpoint. Compaction can also be stopped.

Continue and Compact require saved protocol history and an idle or failed
thread. Stop the running request first. New user input can still supersede a
running request as before. Control operations are recorded as `activity` with
`type: "thread_control"` and an `action` of `cancel`, `continue`, or `compact`.
These records are execution boundaries, never model input. They keep late
responses and concurrent requests isolated even without a new user message.

The authenticated browser endpoints accept an empty POST body:

| Endpoint | Result |
| --- | --- |
| `/api/threads/{id}/cancel` | Updated thread; stopping an idle thread is a no-op |
| `/api/threads/{id}/continue` | Accepted request with its activity `record_idx` |
| `/api/threads/{id}/compact` | Accepted request with its activity `record_idx` |
| `/api/threads/{id}/title` | Updated thread; names it from the full compiled context |

All four operate only within the signed-in user's database. Busy or empty
threads reject Continue and Compact with HTTP 409, and a thread without
protocol history rejects title generation. The title endpoint replays the
thread's compiled context to its model and stores the returned title, so the
rename form can generate one instead of typing it. Poll thread history and
status to observe completion; inference snapshots also follow continuation
requests. Reasoning and Worker audits refer to the request's originating
history record, which may be an input or a control activity.

Deleting a thread removes its history, checkpoints, audit rows, and Worker-call
rows within the owning user database. Other users and threads are independent.

Administrators can enable **Return x-codex-turn-state header** under
Configuration → Experimental features. It is disabled by default. When enabled,
each thread saves the latest upstream `x-codex-turn-state` response header and
returns it unchanged on subsequent Responses requests, including inference,
title generation, and context compaction. A response without the header retains
the previous value. Both JSON and streaming responses update the cache as soon
as their headers arrive, including HTTP error responses.

The cache persists in the owning user's database across service restarts. It is
isolated by thread and upstream URL/credential, and deleted with the thread.
Disabling the feature stops both sending and updating cached values; re-enabling
it resumes from the saved value. The setting is independent of the Thread ID
header switch and applies to both browser and API requests.
