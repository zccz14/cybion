# History table

`#/history` browses the authenticated user's `history_records` table across all
threads. Each database row is one table row.
It is read only. Filters, sort order, page, and page size are retained in the URL.
The thread column shows the current `threads.title` above the original ID, with
a link icon beside the ID that opens the thread. The title comes from the same
database read snapshot as the page and is returned as `thread_title` metadata;
it is not a history column or a snapshot of the thread's former name.

The browser-authenticated `GET /api/history` endpoint accepts:

| Parameter | Behavior |
| --- | --- |
| `page` | Positive page number, default 1; beyond the last page returns the last page. |
| `page_size` | 1–100, default 20. |
| `sort` | `id`, `thread_id`, `kind`, `payload`, or `created_at`; default `id`. |
| `direction` | `asc` or `desc`, default `desc`; equal values use `id` in the same direction. |
| `id`, `thread_id`, `kind` | Exact equality. |
| `created_from`, `created_to` | Inclusive Unix-second bounds on `created_at`. The UI accepts local date/time. |
| `q` | Case-sensitive literal substring in the complete `payload`. |

The response contains `items`, filtered `total`, effective `page`, `page_size`,
`sort`, and `direction`. SQLite performs filtering, sorting, and LIMIT/OFFSET;
the count and rows share a read transaction. The browser does not load the
whole table to compute a page.

List rows preview the first 240 characters of `payload` and carry an explicit
`payload_truncated` flag. Expanding a row fetches `GET /api/history/{id}`, which
returns `id`, `thread_id`, `kind`, `payload`, and `created_at` in full. `payload`
stays a text string, preserving its original formatting even when it is not
valid JSON. `created_at` stays Unix seconds. The UI marks empty text as `""`
and displays `created_at` as a local date/time string in both the table
and expanded row. Filtering and sorting still use the stored numeric value.

Conversation history returns the same five fields, with `payload` decoded as
JSON. The conversation renders inputs, messages, reasoning summaries, tool
results, and runtime activity directly from `kind` and `payload`. Thread naming
reads the input text from its payload.

## Conversation process groups

The conversation derives its display from the combined durable history and
pending response items. Inputs, assistant `response_output` items of type
`message`, and every `activity` record stay outside process groups and end the
preceding group. All other consecutive records form a `ThreadProcessGroup`,
including a single record. Expanding the group renders the original records in
their original order, with their existing payload inspection controls.

Each group starts collapsed and shows its record count and the difference
between its maximum and minimum `created_at` values (Unix seconds). Chinese
labels use `运行了 hh 小时 mm 分钟 ss 秒`; English labels use
`Ran for 01h 02m 03s`, for example. Hours do not wrap after 24. A singleton or
same-timestamp group reports zero. Standalone messages and the current clock
do not contribute to the duration. Pending items retain the existing response
preview timestamp (`started_at`) until durable timestamps become available.

Grouping and disclosure state exist only in the browser. They do not change
stored rows, API payloads, or model context. Stable group keys keep disclosures
open across polling, appends and the preview-to-durable handoff when the
Responses item ID is available. Switching threads or reloading starts with
collapsed groups.

## Storage schema

Schema 9 contains exactly `id`, `thread_id`, `kind`, `payload`, and `created_at`.
All runtime appends use one writer accepting the latter four fields; SQLite
assigns `id`. Display text and roles are derived from the protocol payload.
Current-request checks use the input record's ID without storing an additional
association on each history row.

The upgrade from schemas 7/8 drops `role`, `content`, `visible`,
`request_input_id`, and the request-association index in one transaction. It
preserves all five retained values, the auto-increment sequence, and foreign
keys from audits and Worker calls. It does not create turn tables or reserialize
existing payloads.

Both endpoints resolve the database from the authenticated identity. A thread
filter or record ID cannot select another user's database.
