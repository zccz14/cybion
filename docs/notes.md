# Sticky notes

Sticky notes (便签) are the third kind of governed context, beside the Manual and
the Archive. They are the only kind expected to reach zero.

## Boundary

A note is one short line and one action, and it belongs to exactly one Thread.
That Thread is the only place the note is visible, the only place it can be
crossed out, and the only thing that gives its wording meaning: a note may lean
on the conversation it was written in.

`thread_id` is `NOT NULL` and the controller stamps it from the calling Thread,
so the model can never write into another Thread's notes. There is no mode that
shares a note between Threads; a note that has to outlive its Thread belongs in a
Context, not in a note.

The durable state is `done_at`: a note is open while it is NULL and crossed out
once it is stamped. Crossing out is terminal — there is no edit, no reopen and no
delete for the model. The owner tears a note off (a real delete) from the notes
page, which is also how a wrongly crossed note is repaired: it is torn off and
written again.

A note the caller cannot see is reported as `not_found`, never as forbidden:
another Thread's notes are not part of this Thread's world.

## Injection

Every inference request inserts one synthetic `developer` message immediately
before the newest user input:

```text
Sticky notes (1):
[9f0e1d2c] 确认 GRID 解耦是否生效
Cross out what you finished. A note is visible and crossable only in the Thread
that wrote it. Ask the user when you are blocked.
```

The block is assembled into the request copy only: `history_records` stays exactly
what happened, and compaction and title requests build their own input without it.
A Thread with nothing open gets no block at all — nothing is owed, nothing to say.
Because insertion happens at the tail, the replayed prefix keeps its warm cache.

## Tools

| Tool | Effect |
| --- | --- |
| `add_notes` | `{items: [{text}]}` → `{added: [{note_id, text}], open}` |
| `cross_out_notes` | `{note_ids: [...]}` → `{crossed_out, already_done, not_found}` |

Both limits are answered to the model as tool output it can act on, not as a
failed turn:

```text
note is 143 characters; a note allows at most 120. Condense it into one short
line and call add_notes again.
this Thread already holds 10 open notes; the limit is 10. Cross out what is
finished, or ask the user to tear off the notes that no longer apply.
```

Crossing an already crossed note reports `already_done` and changes nothing, so a
retry is harmless.

## Limits

| Limit | Default | Where |
| --- | --- | --- |
| Note characters | 120 | System configuration (`notes.thread_max_chars`) |
| Open notes per Thread | 10 | Code constant |

The character limit is service configuration, never a database constraint: a long
note is refused with a message that asks for a shorter one, so the text is
rewritten rather than silently truncated. Values are whole numbers from 1 to 2000,
stored in the controller's `app_meta` beside the administrator metadata, and read
with the default above so a fresh deployment needs no seeding step.

The open cap bounds the injected block by construction — at most ten lines per
request — so request assembly never truncates.

## Storage

One `notes` row per note in the owner's database:

| Column | Meaning |
| --- | --- |
| `id` | Eight hex characters, the id the model quotes back. |
| `thread_id` | The owning Thread, `NOT NULL`. No foreign key. |
| `text` | The note itself; immutable after creation. |
| `created_at` | Unix seconds; orders the notes page and the injected block. |
| `done_at` | NULL while open, the crossing time once crossed out. |

Deleting a Thread tears off its notes, open and crossed, and answers
`{"deleted_notes": n}`. A note was written against that Thread's context and
means nothing outside it, so it goes with the Thread; the delete confirmation
lists the open ones before the Thread goes.

## Pages

`#/notes` (Work → Governed contexts → Notes) is the owner's review surface and
shows a note's whole record: the open notes grouped by the Thread that wrote them,
then the crossed ones. Each group is headed by a link into its Thread (with the
Thread id beside it), and every note prints its id, when it was written, and — once
crossed — when it was crossed out, as an absolute timestamp in the UI language with
a machine-readable `<time datetime>` attribute. A crossed note repeats the link to
its Thread, because its row no longer sits under a group.

Each open note offers *cross out* and *tear off*; a crossed note offers *tear off*
only. The page never writes a note: notes come from Threads.

The Tools page lists both tools under the Controller group, and every tool call
renders as its own card in the conversation.

## Non-goals

Notes shared between Threads or between users, several boards, labels,
priorities, drag ordering, due dates and reminders, and extracting notes from a
conversation automatically. A Thread share never exposes the owner's notes.
