# Worker sharing

An owner can grant an existing Cybion user access to a Worker. The grant covers
exactly `bash`, `browser_control`, and `computer_use`. The recipient runs these
tools from their own Threads, model configuration, contexts, and API keys. Worker
device credentials remain with the owner. The device continues using
`/worker/v1/users/{owner}/workers/{worker}` and needs no protocol/config change.

## Storage and identity

Sharing adds exactly two business tables in the existing per-user SQLite files:

| Location | Table | Responsibility |
| --- | --- | --- |
| Owner A | `worker_grants` | Authoritative relationship `(worker_id, grantee_user_id)`, active grant cycle, revocation tombstone, revision and sync progress |
| Recipient B | `shared_workers` | Discovery cache `(owner_user_id, worker_id)`, label, grant cycle, source revision and tombstone |

A's existing `workers` and `worker_calls` retain the Worker and **all** its calls,
including B's. B's existing `history_records` retain B's model/tool history and
internal routing/output provenance. Sharing creates no global database or routing
index, job table, message queue, change ledger, or recipient call-ledger replica.
The administrator database has no sharing role.

`worker_calls.caller_user_id IS NULL` means the owner of that database. This also
applies to migrated local calls: migration does not need to infer the owner's UID.
A non-null caller identifies the database containing that call's Thread, input,
and output record IDs. Those IDs must never be joined to A's Thread/history rows.
Owner audit views leave foreign Thread titles empty and identify the caller;
the recipient's private Thread cannot be opened through the owner's API.

UIDs originate from verified Auth Mini identity and pass the existing safe user ID
validation. Thread execution uses its authenticated owner as caller; arguments
and Worker callbacks cannot supply a caller. Cross-user opens never create a
missing file. Granting oneself or a nonexistent user is rejected. A recipient
cannot grant, rename, delete, check, upgrade, or obtain pairing credentials for a
shared Worker; backend management queries require an owned active Worker.

Schema 22 rebuilds the schema 21 call ledger, preserving IDs, raw payloads,
snapshots, results, receipt/boot fields and indexes. Thread/history foreign keys
are removed from the ledger because their references can be foreign. Worker
references remain local, and Worker deletion is soft deletion. Deleting a Thread
cannot cascade into another user's ledger. Existing schema migrations remain
supported; current-version opens check the version without requesting a migration
write lock. This same migration adds `worker_calls.dispatch_retry_at` and an
indexed eligibility order for queued calls. Migration double-checks the version
under the lock, checks foreign keys, restores enforcement even on error, and
rejects future schema versions.

## Discovery and authorization cycles

`PUT` on an active relationship is idempotent. Regrant after revocation creates a
new `grant_id`; `revision` continues increasing across the entire relationship.
Revocation and rename update the same row rather than adding change records.

The owner commits the relationship first. Rows with `revision > synced_revision`
are pending discovery sync. Sync upserts B's projection only if the source
revision is newer, commits B, then acknowledges A only if the source revision
still matches. Revocation tombstones prevent an old retry from resurrecting a
grant. Grant/revoke/rename/delete attempt sync immediately; failures leave visible
revision lag and retry the latest state, coalescing intermediate changes.

Both worker-list APIs read owned Workers plus active **local** projections. They
never scan other users' databases to discover Workers. Shared cached views report
`status: "unknown"`, `can_upgrade: false`, and omit runtime/credential data.
Shared-only users still receive Worker tools. An exact Worker ID is required;
ambiguous owned/shared or multiple-owner matches are rejected. Reading shared
Worker detail validates A's current grant. Executing tools always validates A,
so a stale or forged projection cannot authorize execution.

## Durable dispatch and results

A committed model tool item in B's existing history records an internal owner,
grant cycle, stable call ID and input boundary. These are columns, not additions
to the Responses payload. Delayed calls capture the cycle before their wait.
An unavailable or ambiguous discovery route is captured as rejected; later
sharing cannot silently authorize that old intent.

Streaming dispatch commits the item and routing before opening A. Recovery uses
that same committed item. A inserts calls idempotently on caller, Thread, input,
and provider call ID and rejects changed arguments or grant cycles. It creates no
fake B Thread in A. Final grant validation and `queued -> delivered` occur in one
A transaction. Claim and replay read B's current Thread/input using a read-only
connection. A known inactive/deleted Thread or missing/revoked grant is a terminal
denial. Missing files, unavailable schemas, and SQLite errors while reading B
instead defer the call for two seconds, retaining its queued/delivered state,
original ID, and grant cycle. Owner database errors propagate. Neither case can
execute while its required state is unavailable. They never inspect A's coincident
Thread/input IDs as if those belonged to B. A does not wait for a B write while
holding its own write transaction.

Worker callbacks match the recorded Worker and delivered call and recover the
immutable caller from A's ledger. A commits the result before acknowledging the
Worker. Temporary B failure does not reject a durably saved result. Delivery
writes an ordinary B history record with a unique `(owner, call, phase)` origin,
then records its ID in A. A crash between B commit and A acknowledgement retries
the same record. Primary failure and late device result have separate phases.
Only minimal delivery progress is added to the ledger; no copied output message
body is stored there. Own calls retain their local atomic history/result path.

A deleted recipient Thread discards output and never recreates the Thread. A
missing/unavailable recipient database leaves delivery pending without creating
one. Shared screenshot outputs carry controller-produced provenance on B's
history record, so rendering/replay need not open A. Arbitrary model/user JSON or
bash output cannot mark itself as a screenshot.

## Revocation, cancellation and restart

Revocation immediately fails queued calls. Regrant never revives old queued,
delayed, recovered, or replayed calls. Cancellation, Thread deletion, and a newer
input prevent subsequent dispatch/claim/replay. An operation already delivered
may continue; neither revocation nor cancellation undoes executed shell effects.
A result that arrives after cancellation is retained as activity rather than
reexecuted. Deleting a Worker revokes discovery and queued calls while preserving
audit/history; it disables device authentication and cannot stop an already
running device side effect.

A Worker boot change settles delivered calls from the previous boot as failed
with `code: "worker_restarted"` and `execution_outcome: "unknown"`; B receives that
outcome. Unknown side effects are never automatically rerun. Same-boot replay is
subject to current authorization and caller-state checks. A live SSE connection
retains deferred replay IDs, rotates at most eight per pass, and alternates replay
and new-claim priority. A temporarily unavailable caller therefore neither loses
its replay nor blocks other callers until reconnection. Upgrade draining counts
all delivered calls in the owner's ledger, including foreign callers.

## API

- `GET /api/workers`: existing array shape, with `owner_user_id` and
  `access: "owner" | "shared"` on every item.
- `GET /api/workers/{id}`: owned detail or authorized sanitized shared detail.
- `GET /api/workers/{id}/grants`: owner-only grant array containing
  `grantee_user_id`, `grant_id`, `revoked_at`, `revision`, `synced_revision`,
  `created_at`, and `updated_at`.
- `PUT /api/workers/{id}/grants/{grantee_user_id}`: no body; returns the grant.
- `DELETE /api/workers/{id}/grants/{grantee_user_id}`: owner-only, returns 204.
- `GET /api/worker-calls`: owner-ledger audit page with SQL filters/count and
  LIMIT/OFFSET; preserves `items`, `page`, `page_size`, `total`. Summary rows have
  `arguments: null`, `result: null`, `worker_resource: null`, `has_details: true`,
  and resolved `caller_user_id`. Summary errors are limited to 1024 characters by
  SQL, including legacy errors containing whole failed results. Payload columns
  are not selected or parsed. A Thread filter includes only the owner's local
  calls; unfiltered device audit includes every caller. Thread-scoped statistics
  follow the same ownership rule.
- `GET /api/worker-calls/{id}`: owner-only lazy full detail, same row shape,
  preserving complete error and result content.

## Recovery, capacity and retention

Queued dispatch attempts at most eight eligible calls per poll. Its partial index
orders by `MAX(created_at, dispatch_retry_at)`, then creation time and ID. A due
retry precedes later arrivals; new calls do not always outrank retries merely
because their retry marker is zero. Temporary caller failures move only that
call's deadline, allowing other callers to progress. A sustained arrival rate
above device throughput still increases queue latency.

The existing five-second recovery supervisor retries pending sharing work while
opening its existing user set; sharing adds no new global scanner. Each user pass
attempts at most 32 grant relationships and 32 output deliveries. Partial indexes
select pending rows without scanning historical result blobs. Last-attempt
ordering lets other pending rows progress when one recipient fails. Cross-user
projection writes use a 100 ms SQLite lock budget. Failures are logged per
recipient/user and leave durable pending state. Empty passes do not broadcast to
recipients; heartbeat/resource updates never fan out to discovery caches.

Relationship metadata grows with distinct owner/Worker/recipient relationships,
including tombstones, rather than number of changes. Calls, screenshots, results,
and ordinary history continue to grow with actual usage. Sharing adds no automatic
retention or payload deletion. Owners retain the full foreign-call payloads on
their devices' ledger; recipients retain their own history. Operators must budget
SQLite/WAL storage for those payloads, backups, pending deliveries and migration
rebuild space. Permanent recipient loss requires operator attention; retries have
bounded work per pass, not an automatic destructive expiry policy. Large user or
pending-work populations can increase recovery latency within the existing
supervisor. Backups/restores should preserve both authoritative revisions and
recipient tombstones/provenance together.
