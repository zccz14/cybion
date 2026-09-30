# Thread context replay

## Boundary

Every protocol item sent or received for a thread is appended to that user's
`history_records` table. The auto-incrementing `history_records.id` is the
record index. It is the only ordering key used to reconstruct a context.

The stored `payload` is immutable evidence. Request assembly operates on a
copy, so replay compatibility cleanup never changes the durable record.
Each thread has one current request. A newer input cancels the previous request.
Output persistence checks the latest input in the same transaction as the
append; output from a superseded request is stored as `activity`.

The protocol kinds are:

```text
input | response_output | tool_output | checkpoint
```

`activity` records describe runtime state for the UI. They remain in history
but are outside the model context and cannot be selected as a context tail.

## Compilation

For a thread and a valid protocol `idx_tail`:

1. Find the greatest checkpoint `id` for that same thread with `id <= idx_tail`.
2. If none exists, use the smallest protocol record for that thread with
   `id <= idx_tail` as `idx_head`.
3. Select every protocol record for that exact thread in the inclusive range
   `[idx_head, idx_tail]`, ordered by `id`.

The checkpoint is included as the first item when one exists. Records from
other threads are never eligible, even when their numeric IDs fall inside the
same range. A missing, foreign, or non-protocol `idx_tail` is an error.

Each Responses request replays this compiled array. Report Threads prepend
their task policy as a developer message; every other request starts with the
conversation records themselves. Compaction and title generation append their
instruction as the final user message after the replayed records, so the
warmed request prefix stays reusable. The report policy is request metadata;
the durable conversation remains the record range above. The compiler uses
`kind` to select protocol records; `activity` stays outside the model context.

## Registry tools

Registered Contexts and Workers are disclosed through controller-answered
tools instead of a replayed prefix. `cybion_list_contexts` returns only
top-level Context metadata, ordered by name and ID. `cybion_list_workers`
returns the registered Worker identities (`worker_id`, `label`), ordered by
label and ID; runtime state such as online status, heartbeat timestamps, and
resource reports is not listed.

Every Worker tool call must include an exact `worker_id` from
`cybion_list_workers`; a Worker is never chosen implicitly. Registration does
not imply availability: inference keeps Worker tool definitions available
whenever the user has registered Workers, even if all of them are offline, and
execution checks availability, returning an offline tool error before queueing
a call.

System-authored prompts and tool descriptions use neutral Context, Worker, and
conversation terminology. User-authored metadata, content, and conversation
history are preserved as supplied.

## Controller-answered waiting

`sleep` waits between 1 and 600 seconds in the controller before the next
model request. It creates no Worker call, so deliberate waiting never inflates
Worker call durations; a stop or a newer input cancels the wait.

Worker tools accept an optional `delay_seconds` (1 to 600) for a known
follow-up: the controller waits before dispatching the call, so
`sleep 300 && do-something` becomes one `bash` call with
`delay_seconds = 300` instead of waking the model up in between. The delay is
controller time; the Worker call duration measures only the command.

## Progressive Context discovery

`cybion_list_contexts` lists only top-level Context metadata, ordered by name
and ID. `read_context` and `GET /api/contexts/{id}` return the current node's
existing `id`, `name`, `description`, `content`, and `parent_id` fields, plus
`children`:

```json
{
  "id": "parent-context-id",
  "name": "Development",
  "description": "Development guidance",
  "content": "Full content of this node",
  "parent_id": null,
  "children": [
    {
      "context_id": "child-context-id",
      "name": "Coding",
      "description": "Coding and testing guidance"
    }
  ]
}
```

Children contain only direct-child metadata (`context_id`, `name`, `description`),
ordered by name and ID. A leaf always returns `children: []`. The current node and
its child metadata are read in one transaction from the requesting user's database.
The model can pass a child's `context_id` to `read_context` to discover the next
level. Child content and deeper descendants are disclosed only when read.

## Replay cleanup

Cleanup works on a request copy:

- remove `action` from `web_search_call`;
- remove `action` and `size` from `image_generation_call`;
- retain a function call pair only when one non-empty `call_id` has exactly one
  `function_call`, exactly one later `function_call_output`, and no ambiguity;
- regroup each assistant segment so message, reasoning, and native items come
  first, every tool call follows, and the tool outputs form one contiguous run:
  strict Responses validators reject any item between a call and its
  unanswered output.

Within those rules other items keep their stored order. Tool output is bounded
only in the request copy; the complete output stays in `history_records.payload`.

Screenshots replay as images when the Worker call ledger says so: a `tool_output`
whose call is `browser_control`/`computer_use` with `action = "screenshot"` and
whose result carries PNG data replays as a real `input_image` part instead of
truncated text. Only the newest screenshot in the compiled range is reinjected;
older ones keep the bounded text form. Size or shape alone never classifies a
result: bash stdout that happens to contain `{"data": ...}` stays text.

## Persistence and retry

The user input is appended before inference. Every Responses output item and
every Worker output is appended in arrival order. After each append, the next
model request recompiles the thread from SQLite and advances its tail to the
new record index. A process restart therefore needs no in-memory context.

When the upstream context window is full, the controller compacts the exact
`[idx_head, idx_tail]` snapshot into a Markdown checkpoint. The checkpoint is
appended only after a transaction verifies that the source tail is still the
latest protocol record. The retry then starts at the new checkpoint record.

A thread also compacts before inference when its estimated replayed context
exceeds the effective context budget (`threads.context_budget_tokens`, falling
back to the user's `thread_defaults.context_budget_tokens`, default 200,000
tokens). The estimate combines the latest measured inference input with appended
record bytes. `0` disables proactive compaction for that thread or user; the
context-overflow path above still applies.

## Audit

Every upstream request records its `thread_id`, `request_kind`, `idx_head`, and
`idx_tail` in `reasoning_audits`, together with lifecycle status, timings,
usage, and the OpenAI-LB request ID. A retry has its own audit row while raw
history remains unchanged.
