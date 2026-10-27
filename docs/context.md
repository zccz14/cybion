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
and are outside the model context, except the Cybion-authored kinds that do take
part in replay: `model_switch` marks a replay barrier, and
`manual_loaded`/`manual_unloaded` compile into the copies of the Manuals a
Thread keeps loaded (see [Loaded Manuals](#loaded-manuals)). `context_dirty`
records, written while a copied Manual could go stale, are retired: they were
renamed to `manual_dirty` by schema 48 and no longer take part in replay, so they
surface only as activity evidence in the browser.

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

Registered Manuals and Workers are disclosed through controller-answered
tools instead of a replayed prefix. `list_manuals` returns only
top-level Manual metadata, ordered by source: the Cybion Common Manual root
first, then the user's local Manuals by name and ID. Every item carries a
`source` field: `common` or `local`. `cybion_list_workers`
returns the registered Worker identities (`worker_id`, `label`), ordered by
label and ID; runtime state such as online status, heartbeat timestamps, and
resource reports is not listed. The Ultimate Machine tools
(`cybion_list_ultimate_machines`, `cybion_get_ultimate_machine`,
`cybion_set_ultimate_machine`, `cybion_delete_ultimate_machine`) are answered
the same way; see [Ultimate machines](machines.md).

`write_manual` creates or edits one of the user's local Manuals — title, Use
When description, body, and parent. Omitting `manual_id` creates a new
Manual: `name` is required, and it starts at the top level or under
`parent_id`. Editing keeps omitted fields at their current values; on either
path a parent is an exact `manual_id` or `null` for the top level, and an
edit may also pass the literal `TRASH`, which moves the Manual into the
trash: the Manual and its subtree disappear from every Manual tool
(a hidden Manual no longer resolves, so `load_manual` refuses it) while
`GET /api/manuals` still
returns the row, so the Manuals page shows each trashed root under Trash.
`POST /api/manuals/{id}/restore` clears the marker and the row returns to its
original place. The read-only Cybion Common Manual cannot be written, and a
hidden Manual cannot be written until it is restored.

A Manual its owner **locked** on the Manuals page refuses every
`write_manual` change — title, Use When description, body, parent, and `TRASH`
alike — and answers with the lock and the way around it: the child Manuals
stay writable, both an existing one and a new one created with `parent_id` set
to the locked id. The lock exists so a hand-written manual keeps its own words
while Threads keep extending it underneath; it belongs to the owner, so nothing
the model sends can set or clear it. The flag is `contexts.locked`, a read
carries it as `locked`, and an owner's `PATCH /api/manuals/{id}` sets or clears
it with `locked` while an edit that omits the field keeps the current value —
move, trash, and restore are the page's own routes and never touch it.

Sticky notes are a separate governed-context kind with their own tools
(`add_notes`, `cross_out_notes`) and their own storage; no Manual tool returns
or edits them. Every inference request also carries one synthetic `developer`
message holding the Thread's open notes immediately before the newest user
input, assembled into the request copy and never into `history_records`. See
[Sticky notes](notes.md).

Every Worker tool call must include an exact `worker_id` from
`cybion_list_workers`; a Worker is never chosen implicitly. It must also carry
a non-empty `summary`: one short sentence, in the user's language, saying why
the model makes the call. The Controller keeps the summary out of the arguments
the Worker receives and renders it on the call card in the conversation.
Registration does not imply availability: inference keeps Worker tool
definitions available whenever the user has registered Workers, even if all of
them are offline, and execution checks availability, returning an offline tool
error before queueing a call.

System-authored prompts and tool descriptions use neutral Manual, Worker, and
conversation terminology. User-authored metadata, content, and conversation
history are preserved as supplied.

## Controller-served delays

Worker tools accept an optional `delay_seconds` for a known follow-up: the
controller waits before dispatching the call, so `sleep 300 && do-something`
becomes one `bash` call with `delay_seconds = 300` instead of waking the model
up in between. The model picks the wait; it must be at least one second and has
no upper bound. The delay is controller time, never part of the Worker call;
the Worker call duration measures only the command, and a stop or a newer input
cancels the wait before anything is dispatched. The countdown is anchored to the
record that committed the call, so a Controller restart does not restart it:
recovery waits only the part still ahead, and a wait that elapsed while the
Controller was down dispatches at once.

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

## Progressive Manual discovery

`list_manuals` lists only top-level Manual metadata. `load_manual`
resolves local Manuals first, then the compiled Cybion Common Manual;
`GET /api/manuals/{id}?lang=` resolves the same local and common nodes for the
browser, with `lang` selecting the common copy (`zh` when absent). Both return
the current node's existing `id`, `name`, `description`, `content`, and
`parent_id` fields, plus `children`:

```json
{
  "id": "parent-context-id",
  "name": "Development",
  "description": "Development guidance",
  "content": "Full content of this node",
  "parent_id": null,
  "children": [
    {
      "manual_id": "child-context-id",
      "name": "Coding",
      "description": "Coding and testing guidance"
    }
  ]
}
```

Children contain only direct-child metadata (`manual_id`, `name`, `description`);
local children are ordered by name and ID while the Cybion Common
Manual keeps its authored order. A local Manual also reports `locked`; a
common node is `locked: false`, because the compiled tree belongs to no owner
and the lock is what `write_manual` refuses (see above). A leaf always returns
`children: []`. The current node and its child metadata are read in one
transaction from the requesting user's database; common nodes come from the
compiled tree instead. The model passes a child's `manual_id` back to
`load_manual` to reach the next level, so child bodies and deeper descendants
are disclosed only when loaded.

## Loaded Manuals

A Manual handed over inside a tool output is message state: the body lives in
that one record, and a compaction moves the replay head past it. `load_manual`
turns the Thread's decision into Thread state instead — one row in
`thread_context_loads` (`thread_id`, `manual_id`, `loaded_at`) — and from then
on the Controller keeps the current copy in front of the model without being
asked. `unload_manual` deletes the row.

The copy travels as an `activity` record the compiler replays as a developer
message, so a Thread receives the Manual JSON the tool answer would have given
it, minus `sort_key`, which orders a sibling list the Thread cannot see.
Every inference attempt compares the Thread's rows against the range it is about
to replay and appends only what the range does not already say:

- the first compile after a load, and the first compile after an edit, because
  the fingerprint of the copy in the range no longer matches the Manual that
  resolves now;
- the first compile after a checkpoint, because the head moved past the copies
  and the Manual must arrive with the conversation the checkpoint replaced.

Nothing is ever rewritten or removed. A superseded copy stays in the transcript
as evidence, and it replays upstream exactly as it was stored, so an earlier
request's prefix stays byte-identical and the provider's prefix cache keeps
working; the next checkpoint retires the copies with the rest of the range. Each
delivery states that it supersedes every earlier copy of the same Manual, so a
Thread holding two versions knows which one is current without the Controller
editing history. A Manual that stops resolving — deleted, or hidden by the
trash — releases itself: the row leaves and one `manual_unloaded` notice says
the copy the Thread holds is stale.

Nothing else announces a loaded Manual: the request that carries the change also
carries the current copy, so there is no older version left to warn about and
nothing to ask the model to fetch.

The notice is evidence, not a message of the turn: the conversation folds a
`manual_loaded`/`manual_unloaded` activity into the process group around it
instead of opening a card of its own, so a turn whose only other records are
tool work shows its reply and nothing else until the reader opens the group.

`unload_manual` deletes the row and nothing else. The copy already in the
conversation stays until the next checkpoint — the Thread declared that it no
longer needs the Manual kept current, not that it never saw it — and the next
compile appends one `manual_unloaded` notice after which nothing refreshes it.
Unloading a Manual the Thread does not hold changes nothing and answers
`unloaded: false`.

A Thread holds twelve loaded Manuals by default. The cap is a setting at two
levels: the User's new-thread default, and a per-Thread override that falls back
to it, so an account that routinely works from more Manuals raises the default
once and a single Thread can still run tighter. A configured cap stays between
one and sixty-four — it bounds what every request of that Thread carries — and a
value outside that range is refused at the settings boundary rather than
clamped. A load past the cap is refused with the count, the cap and the way out
— unload one first — rather than truncated. Lowering a cap unloads nothing: the
bindings stay, and the Thread releases them itself before it loads another. The
loaded-context row reports the set beside the record range and the cap it counts
against (see below), one chip per bound Manual, not one per delivery.

## Loaded-context indicator

The end of the conversation shows which Manuals the Thread keeps loaded. The row
is the last row of the transcript rather than header chrome, so a Thread that
loads many Manuals scrolls its list out of the way instead of holding screen
height. `GET /api/threads/{id}/history/loaded` answers with the current `head`
and `tail`, the bound `manual_id`s in load order, and the `limit` those bindings
count against. This is the same
`[idx_head, idx_tail]` the compiler replays, not a separate stored state, so a
binding whose copy sits behind the head is visible as the range narrows after a
checkpoint.

Each chip shows the Manual's name — resolved through the same caches the
Manuals page fills — links to that Manual on the Manuals page, and carries the
full id in its tooltip. No identifier is printed on the chip: a UUID means
nothing to a reader, and the binding is already in the activity record behind it.

A Thread with no binding and no protocol record reports `head` and `tail` as
`null` and the row stays hidden. A Thread that holds bindings always renders the
count beside the cap it counts against (`3 / 12`), because those copies travel
in every request whether or not the Thread did anything else in the window.

## Cybion Common Manual

`common-manuals/` at the repository root holds the Cybion Common Manual: a
`tree.json` skeleton (each node carries a UUID, plus `name`, `description`,
and `content_file` as `{en, zh}` pairs, under a `revision`) and one Markdown
file per node per language. Rust embeds both via `include_str!`, so the content
is compiled into the controller, is identical for every user of a build, and is
never stored, mutated, or synthesized at runtime; changes ship with releases.
`list_manuals` lists the root first with `source: "common"`, and
`GET /api/common-manuals?lang=` serves the same tree — in the requested
language — to the browser so Configuration → Manuals shows users exactly what
Threads can read. Language selection: the browser reads (`GET
/api/common-manuals`, `GET /api/manuals/{id}`) take an optional
`lang=zh|en` and fall back to the source language `zh`, which is also what the
model-side Manual tools (`list_manuals`, `load_manual`) use.

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

A strict validator can still refuse what the replay carries, and it names one
`input[...]` parameter per request: `Unknown parameter: 'input[9].status'`,
`Expected an ID that begins with 'rs'` for an item `id` that came from another
issuer, and `Expected an array with maximum length 0` for a `reasoning` item's
`content`. A refusal like that is a verdict about the replay, not about the
request's own shape — an unknown field outside `input` stays a real error — so
the turn answers the first refusal inside the same inference and replays the
same context once in portable form. Portable form drops the issuer-scoped fields
from every item, `id` and `status`, and reduces a `reasoning` item to the summary
the next model can read: its raw `content` disappears and, with no summary left,
so does the item. Every other item keeps its text, and the retry costs one extra
request per inference.

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
