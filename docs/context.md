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

Each Responses request prepends its current developer policy, top-level Context
metadata, and registered Worker identities to this compiled array. The policy is request metadata; the
durable conversation remains the record range above. The compiler uses `kind`
to select protocol records; `activity` stays outside the model context.

## Stable registry prefix

Inference and compaction use the same registered Worker list, ordered by label
and ID. The prefix contains only each Worker's ID and label. Online state,
heartbeat timestamps, and resource reports do not change the prefix. Inference
keeps Worker tool definitions available whenever the user has registered Workers,
even if all of them are offline. Execution checks availability and returns an
offline tool error before queueing a call. Adding, removing, or renaming a Worker
can change the prefix.

System-authored prompts and tool descriptions use neutral Context, Worker, and
conversation terminology. User-authored metadata, content, and conversation
history are preserved as supplied.

## Progressive Context discovery

The initial prefix lists only top-level Context metadata, ordered by name and ID.
`read_context` and `GET /api/contexts/{id}` return the current node's existing
`id`, `name`, `description`, `content`, and `parent_id` fields, plus `children`:

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
  `function_call`, exactly one later `function_call_output`, and no ambiguity.

All other items keep their stored order. Tool output is bounded only in the
request copy; the complete output stays in `history_records.payload`.

## Persistence and retry

The user input is appended before inference. Every Responses output item and
every Worker output is appended in arrival order. After each append, the next
model request recompiles the thread from SQLite and advances its tail to the
new record index. A process restart therefore needs no in-memory context.

When the upstream context window is full, the controller compacts the exact
`[idx_head, idx_tail]` snapshot into a Markdown checkpoint. The checkpoint is
appended only after a transaction verifies that the source tail is still the
latest protocol record. The retry then starts at the new checkpoint record.

## Audit

Every upstream request records its `thread_id`, `request_kind`, `idx_head`, and
`idx_tail` in `reasoning_audits`, together with lifecycle status, timings,
usage, and the OpenAI-LB request ID. A retry has its own audit row while raw
history remains unchanged.
