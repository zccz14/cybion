# Thread model

Every conversation is an independent thread owned by one Auth Mini user. A
thread contains a UUID, title, model, status, timestamps, and an append-only
history. Users and API clients can append input to any thread they own.

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
