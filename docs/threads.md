# Thread model

Every conversation is an independent thread owned by one Auth Mini user. A
thread is identified by a time-ordered UUID v7 and carries a title, model,
reasoning effort, Fast mode, an optional context-budget override, status,
timestamps, its creation origin, and an append-only history.
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

An input is one Responses `input` item. Text stays a plain string; a pasted
image makes it a message whose `content` array holds an `input_text` part and
one `input_image` data URL per image. The append endpoints accept optional
`images`, at most 4 per input and each a png/jpeg/webp/gif base64 data URL of
at most 4 MiB of characters. The browser downsizes larger pastes before
sending, and the estimate prices each stored image at a bounded token cost
instead of its base64 length.

The UI exposes `idle`, `running`, and `failed` thread states. Failures append
an activity record and leave the thread ready for a later input.

The composer also offers **Stop**, **Continue**, and **Compact**:

- Stop cancels the current model request and prevents further inference or
  Worker dispatch for that request. Completed history records stay unchanged.
  Already dispatched Worker actions may finish; their late results are kept as
  activity and cannot restart reasoning. The thread returns to `idle`.
- Continue starts from the latest saved protocol record without
  appending a user message or sending a synthetic prompt. New outputs are
  appended to the same thread. The composer draft is retained.
- Compact creates a validated checkpoint from the current context, preserves
  all source records, and returns to `idle` without resuming inference. The
  next continuation starts from that checkpoint. Compaction can also be stopped.

Before each inference request, the thread also compacts automatically once its
estimated replayed context exceeds the effective context budget (per-thread
override, otherwise the user's `thread_defaults.context_budget_tokens`, built-in
default 200,000 tokens; `0` disables proactive compaction). Both endpoints and
the composer popover expose the override.

Continue and Compact require saved protocol history and an idle or failed
thread. Stop the running request first. New user input can still supersede a
running request as before. Control operations are recorded as `activity` with
`type: "thread_control"` and an `action` of `cancel`, `continue`, or `compact`.
These records are execution boundaries, never model input. They keep late
responses and concurrent requests isolated even without a new user message.

The conversation view supports a minimal mode. It folds each turn — the span
from one user input to the next — down to the input plus a single tail item:
the turn's last AI reply or its last activity line, whichever came later.
Earlier replies, activities, and protocol records join the collapsed process
group. The personal default is stored in the user's database and edited under
Configuration → Personal settings; each thread can override it from the
thread settings popover, and the thread value wins. The setting is display
only: it is stored on the thread and defaults rows, and never part of model
input or context compilation.

The authenticated browser endpoints accept an empty POST body:

| Endpoint | Result |
| --- | --- |
| `/api/threads/{id}/cancel` | Updated thread; stopping an idle thread is a no-op |
| `/api/threads/{id}/continue` | Accepted request with its activity `record_idx` |
| `/api/threads/{id}/compact` | Accepted request with its activity `record_idx` |
| `/api/threads/{id}/title` | Updated thread; names it from the full compiled context |

All four operate only within the signed-in user's database. Busy or empty
threads reject Continue and Compact with HTTP 409, and a thread without
protocol history rejects title generation. Automatic naming after a successful
request and the title endpoint share one request path: replay the thread's
compiled context with the naming instruction appended as the final user
message, so both name from the whole conversation. The endpoint stores the
returned title unconditionally for the rename form; automatic naming only
fills a still-`Untitled thread` title. Poll thread history and status to
observe completion; inference snapshots also follow continuation requests.
Reasoning and Worker audits refer to the request's originating history record,
which may be an input or a control activity.

Deleting a thread removes its history, checkpoints, audit rows, and Worker-call
rows within the owning user database. Its source-linked reports and derived
daily reports are removed too. Copies already read into another Thread's
history remain in that destination Thread until it is deleted. Deleting the
report executor Thread preserves independently saved report artifacts but
removes its audit links. Other users' databases are unaffected.

## Origin and external references

A Thread records where it came from. Browser sessions create `web` Threads.
`/v1/threads` creates `api` Threads and stores the API key id that created
them, so integration traffic can be attributed and audited. An integration
client may also send an optional `external_ref` at creation (1-200 visible
characters after trimming) mapping the Thread to its own identifier, such as a
room or task.

Creation records these once, and the Thread views return them. The web UI
marks `api` Threads with an `API` chip in the thread list and the conversation
header, and shows the external reference in the row tooltip.

## Archive and list filters

Archiving hides a Thread from the thread list without deleting anything.
`GET /api/threads` returns active Threads only, and
`GET /api/threads?archived=true` returns the archived ones; both views expose
`archived_at`. `PATCH /api/threads/{id}` with `{"archived":true}` archives a
Thread and `{"archived":false}` restores it. Archived Threads keep their
history, audits, Worker calls, and recovery state, and stay usable through
their normal endpoints; appending input does not restore them. The web UI
lists archived Threads in a collapsed state under the thread list with a
per-row restore action, and the conversation header offers Archive and
Restore.

The list endpoint filters and paginates on the server. Every provided
parameter must match; omitted parameters match anything:

| Parameter | Behavior |
| --- | --- |
| `status` | Persisted execution status: `idle`, `running`, or `failed`. `running` covers both the Running and Compacting displays. |
| `origin` | Creation origin: `web` or `api`. |
| `q` | Case-insensitive substring of the title or `external_ref`; trimmed; at most 200 characters. |
| `limit` | Page size, 1-100; default 30. |
| `cursor` | `next_cursor` from the previous page; walks the filtered list by keyset (`updated_at DESC, id DESC`). |

The response is `{"items": [...], "next_cursor": "…", "total": n}`: `items`
is the page (at most `limit` entries), `next_cursor` continues the walk and
is `null` on the last page, and `total` counts the whole filtered list.
Invalid `status`/`origin`/`limit`/`cursor` values and over-long `q` values
return HTTP 400.

The web UI drives these parameters through one shared control bar: a search
box (300 ms debounce) plus single-select view chips — All / Web / API /
Running / Failed. Web (the existing `view=mine` URL) maps to `origin=web` and opens by default; API maps
to `origin=api`, Running to `status=running`, and Failed to `status=failed`;
search combines with the selected view. The selection lives in the page URL
(for example `#/threads?view=api&q=room`), so a thread list link is
shareable, a reload keeps the selection, and back/forward step through
filter changes. The default view omits `view`, and `q` stores the raw search
text while the server request still trims it. More pages load automatically
when the list footer scrolls into view, and the archived group pages the
same way. The archived group sits outside the filter and keeps showing every
archived Thread. An empty result offers a one-click "Show all" reset to the
widest selection.

## Report-purpose Threads

An account can explicitly create one visible report Thread with purpose
`reports`; other Threads have purpose `work`. Purpose is server-assigned, not
a general editable field. A report Thread uses the common runtime but receives
only four owner-scoped Cybion Controller tools and cannot dispatch Worker,
context or external tools. Report buttons and direct conversation share its
history, audits and controls. It skips automatic naming and Linkit task
notifications. Daily sources/metrics exclude it; general account usage and the
activity heatmap include it. See [Daily reports](daily-reports.md) for its
snapshot-aware continue/restart behavior and retention boundaries.

## Read-only sharing

Owners may authorize existing users to view a live Thread through the separate
[Thread sharing](thread-sharing.md) endpoints. Ownership, execution, integration
API keys and model tools retain their existing owner-only scope. Shared browser
reads authorize against the owner's grant in the same transaction as the read;
recipient discovery entries do not themselves confer access. Deleting a Thread
also atomically revokes its grants while keeping synchronization tombstones.
