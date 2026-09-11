# Flat thread model

Every Cybion conversation is a peer thread. A thread has a UUID, title, model,
status, timestamps, an ordered history, and independently persisted runs.

There is no privileged main thread, subthread, fork boundary, Goal, or implicit
handoff. A user or API client can append an input to any owned thread. The input
is written before the run starts, so it is never lost if a process exits after
accepting the request.

```text
thread
  ├── history_records: user, assistant, system, tool
  └── thread_runs: queued, running, completed, failed
```

The UI shows a thread as `idle`, `running`, or `failed`. A failed run writes a
system record and leaves both the run and its thread in a terminal failed state;
the user can append another direct input when ready.

Thread deletion removes that thread's history, runs, and Worker-call rows inside
the same tenant database. It does not affect any other thread or tenant.
