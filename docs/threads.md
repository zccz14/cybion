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

The UI exposes `idle`, `running`, and `failed` thread states. Failures append a
visible activity record and leave the thread ready for a later input.

Deleting a thread removes its history, checkpoints, audit rows, and Worker-call
rows within the owning user database. Other users and threads are independent.
