# Sticky notes

Sticky notes (便签) are the third kind of governed context, beside the Manual and
the Archive. They are the only kind expected to reach zero.

## Boundary

A note is one short line and one action. It has two scopes:

| Scope | Visible in | Crossable by | Writing contract |
| --- | --- | --- | --- |
| Attached (`thread_id` set) | Only that Thread | Only that Thread | May lean on the Thread's context |
| Global (`thread_id` NULL) | Every Thread | Every Thread | Must read on its own |

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
Sticky notes — global (1):
[a1b2c3d4] 交 11 月房租
Sticky notes — this thread (1):
[9f0e1d2c] 确认 GRID 解耦是否生效
Cross out what you finished. Global notes are shared with every thread; a note
attached to this thread is visible and crossable only here. Ask the user when you
are blocked.
```

The block is assembled into the request copy only: `history_records` stays exactly
what happened, and compaction and title requests build their own input without it.
A Thread with nothing open gets no block at all — nothing is owed, nothing to say.
Because insertion happens at the tail, the replayed prefix keeps its warm cache.

## Tools

| Tool | Effect |
| --- | --- |
| `add_notes` | `{scope?: "thread" \| "global", items: [{text}]}` → `{scope, added: [{note_id, text}], open: {thread, global}}` |
| `cross_out_notes` | `{note_ids: [...]}` → `{crossed_out, already_done, not_found}` |

`scope` defaults to `thread`; the controller stamps `thread_id` from the calling
Thread, so the model can never write into another Thread's notes. Crossing an
already crossed note reports `already_done` and changes nothing, so a retry is
harmless.

Both limits are answered to the model as tool output it can act on, not as a
failed turn:

```text
note is 143 characters; thread notes allow at most 120. Condense it into one short
line and call add_notes again.
thread notes already hold 10 open items; the limit is 10. Cross out what is
finished, or ask the user to tear off the notes that no longer apply.
```

## Limits

| Limit | Default | Where |
| --- | --- | --- |
| Thread note characters | 120 | System configuration (`notes.thread_max_chars`) |
| Global note characters | 200 | System configuration (`notes.global_max_chars`) |
| Open notes per Thread | 10 | Code constant |
| Open global notes | 10 | Code constant |

The character limits are service configuration, never a database constraint: a
long note is refused with a message that asks for a shorter one, so the text is
rewritten rather than silently truncated. Values are whole numbers from 1 to
2000, stored in the controller's `app_meta` beside the administrator metadata,
and read with the defaults above so a fresh deployment needs no seeding step.

The two open caps bound the injected block by construction — at most twenty lines
per request — so request assembly never truncates.

## Storage

One `notes` row per note in the owner's database:

| Column | Meaning |
| --- | --- |
| `id` | Eight hex characters, the id the model quotes back. |
| `thread_id` | The owning Thread, or NULL for a global note. No foreign key. |
| `text` | The note itself; immutable after creation. |
| `created_at` | Unix seconds; orders the notes page and the injected block. |
| `done_at` | NULL while open, the crossing time once crossed out. |

Deleting a Thread tears off its notes, open and crossed, and answers
`{"deleted_notes": n}`. A note was written against that Thread's context, so
promoting it to global would only manufacture a note no other Thread can read;
the delete confirmation lists the open ones before the Thread goes.

## Pages

`#/notes` (Work → Governed contexts → Notes) is the owner's review surface: one
input for a new global note, then the open notes grouped by scope — global first,
then one group per Thread with a link back — and a collapsed list of crossed
notes. Each open note offers *cross out* and *tear off*; a crossed note offers
*tear off* only. The page shows each note's id and, past a day, its age.

The Tools page lists both tools under the Controller group, and every tool call
renders as its own card in the conversation.

## Non-goals

Several boards, labels, priorities, drag ordering, due dates and reminders,
extracting notes from a conversation automatically, and sharing notes with
another user. A Thread share never exposes the owner's notes.
