# History table

`#/history` browses the authenticated user's `history_records` table across all
threads. Each database row is one table row, including `visible = 0` records.
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
| `sort` | Any of the nine original column names, default `id`. |
| `direction` | `asc` or `desc`, default `desc`; equal values use `id` in the same direction. |
| `id`, `thread_id`, `request_input_id`, `kind`, `role`, `visible` | Exact equality; `visible` accepts 0 or 1. |
| `created_from`, `created_to` | Inclusive Unix-second bounds on `created_at`. The UI accepts local date/time. |
| `q` | Case-sensitive literal substring in the complete `content` or `payload`. |

The response contains `items`, filtered `total`, effective `page`, `page_size`,
`sort`, and `direction`. SQLite performs filtering, sorting, and LIMIT/OFFSET;
the count and rows share a read transaction. The browser does not load the
whole table to compute a page.

List rows preview the first 240 characters of `content` and `payload` and carry
explicit `content_truncated` / `payload_truncated` flags. Expanding a row fetches
`GET /api/history/{id}`, which returns all nine stored fields in full. `payload`
stays a text string, preserving its original formatting even when it is not
valid JSON. `visible` stays an integer, `request_input_id` preserves SQL NULL,
and `created_at` stays Unix seconds. The UI marks empty text as `""`, SQL NULL as
`NULL`, and displays `created_at` as a local date/time string in both the table
and expanded row. Filtering and sorting still use the stored numeric value.

## Field meanings

- `visible` is a conversation presentation hint. Inputs and nonempty assistant
  text normally use 1; protocol/tool records and checkpoints normally use 0.
  The conversation can still render 0-valued records as specialized or collapsed
  entries. It is not an access-control flag or a context-replay filter.
- `request_input_id` references the input row that caused an output. This groups
  assistant/tool outputs with their source request and keeps outputs superseded
  by later inputs out of context replay. Input rows, checkpoints, and some
  activity rows have NULL because they are not assigned to an input this way.
- `payload` stores the complete structured record as JSON text. `content` is a
  separate, derived display-text column: message text, reasoning summary, tool
  output text, or a protocol-item label. Context replay reads `payload`; parts
  of conversation rendering, thread naming, and text search read `content`.
  Keeping `content` is a convenience, not an independent source of truth. A
  payload-only design is possible by deriving the text at these read sites.

Both endpoints resolve the database from the authenticated identity. A thread
filter or record ID cannot select another user's database. The existing
`/api/threads/{id}/history` conversation contract is unchanged.
