# Thread sharing

An owner A can give an existing Cybion user B **viewer** access to one Thread.
This is a live view of the original Thread: all previous conversation content
and future updates are included, not a copied snapshot. A remains the sole owner.
The grant neither transfers execution identity nor grants access to Workers,
Contexts, upstreams, credentials, account-wide audits or other Threads.
Integration API keys and Controller/model tools keep their existing owner scope.

## User experience

A opens **Share Thread** in the conversation header, picks the recipient
through the Linkit user picker — search by username or UUID — acknowledges the
content boundary, and chooses **Authorize viewing**. B can copy **My user ID**
from **Work → Shared with me** (also available on the Workers page) when A needs
the exact ID. The dialog lists active/revoked recipients and pending discovery
propagation.
A header chip keeps the active share count visible even when the dialog closes.
An active grant's repeated PUT is idempotent. Self-grants and recipients who have never signed in to Cybion fail.
No invitation, email lookup, public user directory or anonymous capability link is
created. Deployment itself grants nobody access to a Thread.

The access link is `#/shared-threads/{owner_user_id}/{thread_id}`. It contains no
secret. An authenticated request must still match the owner's current grant.
Only this validated same-origin route is preserved across hosted sign-in; query
parameters are not forwarded. An owner opening their link returns to their usual
owned Thread page. Forwarding B's link does not authorize C.

**Shared with me** is a separate read-only list ordered by sharing time. It shows
source-authorized title/status, owner UID, sharing time and a read-only label.
Hiding/restoring a row changes only B's list; a hidden Thread remains readable by
link. Regrant starts a new grant cycle and restores discovery visibility. Own
Thread origin chips are labelled **Web / API**, independent of ownership; the
existing `view=mine` URL still selects web-created owned Threads.

The viewer reuses the conversation renderer, process groups, history windows,
image previews, screenshot provenance and live output preview. It has no composer,
execution controls, model/default editors, sharing manager or owner resource
queries. Minimal display is local component state and cannot change A's settings.
All controls support English/Chinese, keyboard use, light/dark and narrow screens.

## Content boundary

The share includes user messages, assistant output, displayed reasoning summaries,
checkpoints, tool calls/results and recorded images. Existing text or images may
contain confidential information: **sharing does not automatically redact recorded
content**. A approves the whole conversation and its future content, not only the
currently expanded visual portion. Worker sharing remains a separate permission.

Shared endpoints return explicit DTOs rather than the owner configuration view.
Thread metadata omits upstream IDs, external integration references, defaults and
execution settings. History uses an allowlist of conversation fields; encrypted
reasoning/replay state and extra provider fields are omitted. Tool result bodies
remain the recorded content. Sharing audit events are not exposed to recipients.
Live response projection contains only lifecycle timing/status, completion, and
allowlisted output items with their durable IDs. Provider request IDs, rate
limits, raw errors and other upstream response metadata are not returned.

The browser uses the existing inline/data-URL images, not a new public attachment
endpoint. Existing links inside message content do not confer permission to their
target or cause Cybion to attach A's credentials to B's request.

## Storage and authorization

Schema 24 adds two business tables to the existing per-user SQLite databases:

| Database | Table | Purpose |
| --- | --- | --- |
| A | `thread_grants` | Authoritative `(thread_id, grantee_user_id)`, viewer permission, grant cycle, revocation, revision and sync progress |
| B | `shared_threads` | `(owner_user_id, thread_id)` discovery route, grant cycle, revision, revocation, sharing time and local hidden state |

There is no global routing database and no conversation/title/status replica in B.
Cross-user reads open only existing files, read-only, and require the current
schema. Cross-user projection writes also never create a missing user database.
The requesting identity always comes from verified browser authentication, never
request parameters. IDs in URLs locate a source, not an authorization authority.

**Every shared metadata/history/window/preview read validates A's live grant and
reads content in the same A read transaction.** A forged, stale or missing local
projection cannot authorize reads. A valid grant can be opened directly by link
even before discovery sync. Record queries retain the source Thread constraint;
record IDs and the same Thread IDs in different users' databases cannot select a
foreign record. B's existing owner endpoints still resolve B's database only.
Browser share endpoints do not accept integration API keys. No shared execution
or configuration endpoint exists. Recognized write methods return 405; unknown
API paths return 404 instead of falling through to the SPA.

Successful shared reads and owner grant routes carry `Cache-Control: no-store`.
Frontend query keys contain session, viewer, owner, Thread and, for content, grant
cycle. Content is not persisted in browser storage. Loss of access unmounts the
reader, aborts requests, removes its query cache, stops polling and offers an
explicit access recheck. Switching accounts/Threads or grant cycles cannot reuse
old content. Temporary source failures remain visible and retryable instead of
being interpreted as revocation or permanently deleting an index.

## Discovery sync and bounded work

Grant/revoke commits A first, immediately attempts discovery sync, and reports
`revision != synced_revision` while propagation is pending. The existing recovery
supervisor retries at most 32 pending relationships per user pass, ordered by last
attempt and modification time. Each recipient write has a 100 ms SQLite lock
budget and happens without an A write transaction held. Multiple changes coalesce
to the latest source row. B accepts only a strictly newer revision; A acknowledges
only the revision actually copied. A revoke/regrant gets a new `grant_id` while
relationship revisions keep increasing. Old retries cannot resurrect revoked
projections or overwrite a newer cycle.

A shared list request keyset-pages B's active relationship index, default/max 30
candidates, then validates and hydrates only those candidates from their owners.
It never scans all other users or joins account-wide history. Denied candidates
are omitted; pages can therefore be short or empty while still carrying a next
cursor. Follow that cursor to continue. An unavailable source fails the current
page visibly and retains its indexes for retry. This release does not provide
cross-owner search or sort-by-last-message, and does not fan out on token updates.
The schema has partial indexes for pending sync and active visible/hidden lists.
Payload reads retain the existing whole-turn history window behavior; a very long
single turn can still be large. Polling and recovery work grows with actual shares
and loaded pages; this feature does not introduce automatic data retention.

## Lifecycle, audit and deletion

- Grant and manual revoke changes append owner-only `activity` records with actor,
  recipient, grant cycle, action and revision. They do not enter model context,
  change the current request boundary or start inference. Idempotent operations
  do not append duplicate audit records.
- Revocation commits in A independently of discovery sync. Reads authorized after
  that commit fail immediately. An in-flight read already authorized under an
  earlier SQLite snapshot may complete; transmitted/read/copied material cannot
  be recalled. A's running model/Worker operation is not cancelled.
- A database trigger marks all active grants revoked in the same transaction as
  **any** Thread deletion. Grant rows deliberately have no cascading Thread FK:
  their tombstones survive to sync recipients even after content is gone. Direct
  source access also requires the Thread to still exist. API deletion attempts
  sync immediately; supervisor recovery handles pending propagation. Deleted
  Thread history (including sharing audit activities) follows existing retention.
- Archiving changes A's own list only and does not revoke a share. B's hide action
  cannot archive/delete A's Thread or revoke other users.
- A missing/unavailable source never falls back to cached content and is never
  created by a read. A missing recipient leaves propagation pending; it is never
  recreated by the projector.

## API

All endpoints below require a browser Auth Mini bearer token.

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/threads/{id}/grants` | Owner-only grant array |
| PUT | `/api/threads/{id}/grants/{grantee_user_id}` | Owner-only viewer grant; empty body |
| DELETE | `/api/threads/{id}/grants/{grantee_user_id}` | Owner-only revoke, 204; repeated revoke is a no-op |
| GET | `/api/shared-threads?hidden=false&limit=30&cursor=…` | `{items, next_cursor}`; `hidden=true` selects hidden rows |
| GET | `/api/shared-threads/{owner}/{id}` | Authorized shared Thread metadata |
| GET | `/api/shared-threads/{owner}/{id}/history/window?before=…` | `{records, has_older}`, same turn windows as owner history |
| GET | `/api/shared-threads/{owner}/{id}/history?after=…` | Allowlisted incremental history array |
| GET | `/api/shared-threads/{owner}/{id}/response` | Allowlisted live output preview or null |
| PATCH | `/api/shared-threads/{owner}/{id}/visibility` | Recipient-local `{"hidden": true/false}`, 204 |

The permission value is always `viewer`. Neither link parameters nor a supplied
permission field can grant execution rights. Invalid pagination is 400; absent,
foreign, deleted or revoked shared objects are 404. Unauthenticated browser
requests are 401. Database/schema availability failures remain errors, never a
successful stale response. Shared list counts are intentionally not advertised as
an exact authorized total before candidate hydration.

## Migration, verification and complexity

The 23→24 migration is additive: two tables, their indexes, and a delete trigger.
Existing grants, worker ledgers, Thread payloads/IDs and credentials stay intact;
all new Thread grant tables start empty. Normal release deployment snapshots the
SQLite databases privately before upgrading. Do not downgrade to a pre-24 binary
after migration; it rejects the future schema. Restore backups only as a deliberate
recovery operation: older grant state may lose later revocations and older history
cannot undo anything already read or executed. Restore related user databases
consistently rather than resurrecting one stale discovery projection in isolation.

New decision paths represent real boundaries: owner vs viewer, active vs revoked
cycles, visible vs hidden discovery, current vs stale sync revisions, access loss
vs temporary availability failure, and supported conversation payload categories.
They are localized to this module and the separate read-only UI. The only new
compatibility path is schema migration, owned by Controller storage maintainers;
it can be retired once the supported schema floor and all retained backups are
24 or newer. There is no anonymous-link, editor-role, or legacy shared API branch.

Tests cover the real authenticated HTTP router (including bearer/API-key separation,
forwarded links and every read surface), idempotency, audit/context separation,
source read-only transactions, revoke races, pagination, deletion rollback,
archive semantics, missing files, failed sync/restart/regrant, stale tombstones,
allowlisted live/history data and screenshot provenance. Browser tests exercise
consent, clipboard links, focus restoration, read-only pages, history/live updates,
revocation with an in-flight older page, cache clearance, account switches,
temporary errors, local visibility, and bilingual/mobile/dark rendering.
