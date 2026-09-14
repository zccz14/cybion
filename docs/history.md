# History table

`#/history` browses the authenticated user's `history_records` table across all
threads. Each database row is one table row, including `visible = 0` records.
It is read only. Filters, sort order, page, and page size are retained in the URL.

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
`NULL`, and shows a local-time annotation alongside the stored timestamp.

Both endpoints resolve the database from the authenticated identity. A thread
filter or record ID cannot select another user's database. The existing
`/api/threads/{id}/history` conversation contract is unchanged.
