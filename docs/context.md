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
and are outside the model context, except two Cybion-authored kinds that do take
part in replay: `model_switch` marks a replay barrier, and `context_dirty`
compiles into the developer message that tells a Thread which Contexts it read
have changed since.

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

Each Responses request replays this compiled array, starting with the
conversation records themselves. Compaction and title generation append their
instruction as the final user message after the replayed records, so the
warmed request prefix stays reusable. The durable conversation remains the
record range above. The compiler uses `kind` to select protocol records;
`activity` stays outside the model context.

## Registry tools

Registered Contexts and Workers are disclosed through controller-answered
tools instead of a replayed prefix. `cybion_list_contexts` returns only
top-level Context metadata, ordered by source: the Cybion Common Context root
first, then the user's local Contexts by name and ID. Every item carries a
`source` field: `common` or `local`. `cybion_list_workers`
returns the registered Worker identities (`worker_id`, `label`), ordered by
label and ID; runtime state such as online status, heartbeat timestamps, and
resource reports is not listed. The Ultimate Machine tools
(`cybion_list_ultimate_machines`, `cybion_get_ultimate_machine`,
`cybion_set_ultimate_machine`, `cybion_delete_ultimate_machine`) are answered
the same way; see [Ultimate machines](machines.md).

`write_context` creates or edits one of the user's local Contexts — title, Use
When description, body, and parent. Omitting `context_id` creates a new
Context: `name` is required, and it starts at the top level or under
`parent_id`. Editing keeps omitted fields at their current values; on either
path a parent is an exact `context_id` or `null` for the top level, and an
edit may also pass the literal `TRASH`, which moves the Context into the
trash: the Context and its subtree disappear from every Context tool
(`read_context` reports them as missing) while `GET /api/contexts` still
returns the row, so the Contexts page shows each trashed root under Trash.
`POST /api/contexts/{id}/restore` clears the marker and the row returns to its
original place. The read-only Cybion Common Context cannot be written, and a
hidden Context cannot be written until it is restored.

A Context its owner **locked** on the Contexts page refuses every
`write_context` change — title, Use When description, body, parent, and `TRASH`
alike — and answers with the lock and the way around it: the child Contexts
stay writable, both an existing one and a new one created with `parent_id` set
to the locked id. The lock exists so a hand-written manual keeps its own words
while Threads keep extending it underneath; it belongs to the owner, so nothing
the model sends can set or clear it. The flag is `contexts.locked`, a read
carries it as `locked`, and an owner's `PATCH /api/contexts/{id}` sets or clears
it with `locked` while an edit that omits the field keeps the current value —
move, trash, and restore are the page's own routes and never touch it.

Sticky notes are a separate governed-context kind with their own tools
(`add_notes`, `cross_out_notes`) and their own storage; no Context tool returns
or edits them. Every inference request also carries one synthetic `developer`
message holding the Thread's open notes immediately before the newest user
input, assembled into the request copy and never into `history_records`. See
[Sticky notes](notes.md).

Every Worker tool call must include an exact `worker_id` from
`cybion_list_workers`; a Worker is never chosen implicitly. Registration does
not imply availability: inference keeps Worker tool definitions available
whenever the user has registered Workers, even if all of them are offline, and
execution checks availability, returning an offline tool error before queueing
a call.

System-authored prompts and tool descriptions use neutral Context, Worker, and
conversation terminology. User-authored metadata, content, and conversation
history are preserved as supplied.

## Controller-served delays

Worker tools accept an optional `delay_seconds` for a known follow-up: the
controller waits before dispatching the call, so `sleep 300 && do-something`
becomes one `bash` call with `delay_seconds = 300` instead of waking the model
up in between. The model picks the wait; it must be at least one second and has
no upper bound. The delay is controller time, never part of the Worker call;
the Worker call duration measures only the command, and a stop or a newer input
cancels the wait before anything is dispatched.

## Bash command timeouts

`bash` accepts an optional `timeout_seconds`, measured by the Worker from when
execution starts, so a `delay_seconds` wait never counts toward it. The model
picks the limit with no upper bound; it defaults to 600 seconds, and a command
that exceeds it is killed and the call fails.

The Controller enforces the same limit as a backstop: a delivered call that
outlives its timeout by a 30-second grace is cancelled on the Worker, and when
no confirmation arrives within another 30 seconds the Controller answers the
call itself with a `timeout_cancel_unconfirmed` failure whose outcome is
unknown, so the model can clean up before continuing.

## Progressive Context discovery

`cybion_list_contexts` lists only top-level Context metadata. `read_context`
resolves local Contexts first, then the compiled Cybion Common Context;
`GET /api/contexts/{id}?lang=` resolves the same local and common nodes, with
`lang` selecting the common copy (`zh` when absent). Both return the current node's existing `id`, `name`, `description`,
`content`, and `parent_id` fields, plus `children`:

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

Children contain only direct-child metadata (`context_id`, `name`, `description`);
local children are ordered by name and ID while the Cybion Common
Context keeps its authored order. A local Context also reports `locked`; a
common node is `locked: false`, because the compiled tree belongs to no owner
and the lock is what `write_context` refuses (see above). A leaf always returns `children: []`. The
current node and its child metadata are read in one transaction from the
requesting user's database; common nodes come from the compiled tree instead.
The model can pass a child's `context_id` to `read_context` to discover the next
level. Child content and deeper descendants are disclosed only when read.

## Read-context indicator

The conversation header shows which Contexts the Thread has read **and still
holds**, and whether the copy it read is still the current one.
`GET /api/threads/{id}/history/reads` answers with the current `head` and `tail`
plus the `read_context` calls inside that range, each carrying its record and the
`state` the controller judged: `current`, `changed`, `unanswered` (the answer
carried no Context body) or `missing` (the Context no longer resolves). Calls
before the head are not in the answer, so when a compaction appends its
checkpoint the reads it summarized leave the list and only the reads made after
the checkpoint stay. This is the same `[idx_head, idx_tail]` the compiler
replays, not a separate stored state.

The verdict compares two fingerprints of the Context's own content — its title,
Use When description, and body — and nothing around it: moving a Context,
reordering its siblings, or editing a child leaves the fingerprint alone, because
a read registers content rather than the tree. The read fingerprint comes from
the stored tool output, so it is the version the model actually received; the
current one resolves the same id the way `read_context` resolves it — local
Contexts first, then the compiled common tree in its source language.

Each Context appears once, in the order the Thread first read it, with the newest
read deciding its state: a Thread that read a Context before and after an edit
holds the edit. The chip shows the Context's name, a link to it, and only the
states worth noticing — edited, never answered, gone. A current Context is not
marked, a repeat read shows its count, and the tooltip carries the full id and
the record that read it. No identifier or fingerprint is printed on the chip: a
UUID means nothing to a reader, and both are already in the activity record and
the tool output behind it.

The row also shows the record range it was computed from, so a head that moved to
a checkpoint is visible. A Thread with no protocol record yet reports `head` and
`tail` as `null` and the row stays hidden. A range without a `read_context` call
renders the row with a count of zero, which is the signal that the Thread has not
read any Context in this window.

### Changed Contexts are announced

Before an inference request compiles, the controller compares every Context the
Thread read inside that window against what the same read returns now. When one
changed, it appends a `context_dirty` activity record naming the Context, the
record that read it, and the current fingerprint, and the compiler replays that
record as a developer message. The message is a requirement rather than a hint:
it declares the copies in the conversation stale and unusable, requires one
`read_context` call per Context before the next tool call or answer, and forbids
falling back to the old copy when a read fails. The notice is durable — it stays in the
transcript, and in every later replay of the range, until a checkpoint replaces
it — and the record is also what keeps a Thread from being told the same change
on every attempt: a Context is announced once per `(read record, current
fingerprint)` pair, so a further change is a new pair and is announced again,
while a notice already made is not repeated.

The announcement runs in the transaction that compiles the request, after the
request boundary and the Thread's status are confirmed, so it belongs to the
range that request replays and cannot race a newer input. A Context the Thread
re-read after the change is current again and is not announced. A Context that is
no longer readable — deleted, or hidden by the trash — is not announced, because
there is nothing left to re-read; the header marks it instead. The notice names
ids rather than titles: the ids are what `read_context` takes, and a title may
itself have changed.

## Cybion Common Context

`common-contexts/` at the repository root holds the Cybion Common Context: a
`tree.json` skeleton (each node carries a UUID, plus `name`, `description`,
and `content_file` as `{en, zh}` pairs, under a `revision`) and one Markdown
file per node per language. Rust embeds both via `include_str!`, so the content
is compiled into the controller, is identical for every user of a build, and is
never stored, mutated, or synthesized at runtime; changes ship with releases.
`cybion_list_contexts` lists the root first with `source: "common"`, and
`GET /api/common-contexts?lang=` serves the same tree — in the requested
language — to the browser so Configuration → Contexts shows users exactly what
Threads can read. Language selection: the browser reads (`GET
/api/common-contexts`, `GET /api/contexts/{id}`) take an optional
`lang=zh|en` and fall back to the source language `zh`, which is also what
model-side tool reads (`cybion_list_contexts`, `read_context`) use.

## Replay cleanup

Cleanup works on a request copy:

- remove `action` from `web_search_call`;
- remove `action` and `size` from `image_generation_call`;
- retain a function call pair only when one non-empty `call_id` has exactly one
  `function_call`, exactly one later `function_call_output`, and no ambiguity;
- regroup each assistant segment so message, reasoning, and native items come
  first, every tool call follows, and the tool outputs form one contiguous run:
  strict Responses validators reject any item between a call and its
  unanswered output;
- drop the envelopes recorded before the newest `model_switch` barrier (see
  below).

Within those rules other items keep their stored order. Tool output is bounded
only in the request copy; the complete output stays in `history_records.payload`.

Stored media references resolve while the request copy is compiled: a
`result_ref` becomes the `image_generation_call`'s base64 `result`, and an
`image_ref` part becomes its `input_image` data URL. Replay therefore sends the
same inline media it sent before the object store existed; only the stored
record shows the reference.

## Model switches

Upstreams encrypt reasoning, function arguments, and content parts so only the
model that produced them can decode the envelope. A Thread that keeps replaying
after `threads.model` or `threads.upstream_id` changes therefore records an
`activity` record with `$.type = "model_switch"`, whose `from` and `to` carry
the `(model, upstream_id)` pair, before the next attempt compiles. Every
inference attempt passes that check, so a switch made while a run is in flight
is recorded by the next attempt.

Only envelopes are issuer-bound. Everything recorded before the newest barrier
replays without them: an item that carries nothing but an envelope — a
`compaction`, a `context_compaction`, or a `reasoning` whose only payload is
`encrypted_content` — disappears, while every other item keeps its text and
loses `encrypted_content`, `encrypted_function_args`, and `encrypted_content`
parts. Reasoning text survives because a thinking-mode provider (DeepSeek)
rejects a replayed tool-call turn whose assistant reasoning is missing, and it
is plain text the next model reads like any other.

The barrier itself is never sent upstream. Records appended after it replay
unchanged, so the switched model's own envelopes survive. A checkpoint compiled
after the barrier moves `idx_head` past it, and the barrier then has no effect.

A barrier only counts when it moved the replay target. An audit written before
`schema 40` stored no `upstream_id`, so that half of the pair is unknown rather
than different; builds between 37 and 40 recorded a barrier for those Threads
anyway, describing a switch from a model to itself. Such a record stays in the
transcript and does not bound the strip.

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
