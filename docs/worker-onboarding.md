# Worker onboarding

## User flow

**Connect a device → install/start → explicitly authorize → verify execution.**
The guide distinguishes this computer from a remote target, requires an explicit
platform choice, serves a recommended release manifest, and supplies downloads,
checksum-verified commands, recovery instructions and a manual-config escape hatch.

Device-initiated setup opens `#/workers?code=…`. Auth Mini's callback preserves
only the validated, non-secret code. A signed-in user reviews self-reported device
metadata, matches the code on the target and explicitly confirms scope before
approval. Refreshes restore server-side state from the code URL. The first task
is prefilled with the exact Worker ID and still requires the user's Send action.

## Protocol and security boundaries

- `POST /worker/v1/pairings`: device-generated secret, credential **hash**, hostname,
  platform and version. Returns a random request ID, 48-bit human code and expiry.
- `GET /worker/v1/pairings/{id}`: requires the separate high-entropy device secret
  as a Bearer header. Returns status and, after approval, account/machine IDs.
  The device already owns its long-lived token; it is never delivered through
  a browser, URL, command, or server plaintext store.
- `/api/worker-pairings/{code}`: authenticated GET review, POST explicit approval,
  DELETE reject. Ownership is permanently reserved before provisioning a tenant
  record; retries can only resume for the same owner. Approval is idempotent and
  never recreates a deleted, already-approved Worker. Metadata polling is
  intentionally replayable until expiry to recover lost network responses.
- Codes expire after 10 minutes. Approval gives a fresh 10-minute claim window.
  Expired sessions are removed 24 hours after expiry. Request creation is capped
  globally at 120/min; polling at 6000/min and once per 2 seconds per request;
  authenticated lookups at 60/min/account and approvals/rejections at 30/min/account.
  Admission caps are global, not spoofable forwarded-IP limits. This bounds abuse,
  but global saturation can temporarily deny pairing; the UI/CLI expose retries.
- `pairings.sqlite3` contains hashes and state in the private controller data
  directory. Tenant Worker records remain in the owning user's database. All
  normal Worker routes use existing per-worker credential authentication.

Provisioning crosses two SQLite databases. The durable `approving` reservation
is committed first, followed by idempotent tenant insertion and final approval.
A transient failure resumes under the same owner; it never switches accounts.
An abandoned, partially provisioned request may leave a never-connected record,
which is visible and removable. There is no claim of cross-database atomicity.

## Readiness

- Never connected is displayed separately from offline.
- Heartbeat online does not mean executable.
- An authenticated `POST /api/workers/{id}/check` queues a fixed `diagnostics`
  operation through the real SSE event channel. Its result is posted to
  `/worker/v1/users/{user}/workers/{worker}/checks/{id}/result` using the Worker
  credential. These checks never create a model thread or incur inference.
- Checks expire after 30 seconds; duplicate requests within that window reuse the
  same check. Results are bound to the delivered check and exact Worker ID.
- Shell is ready only after the fixed command succeeds. Browser detection and
  desktop permission guidance are explicitly unverified. A headless Linux host
  can be ready for shell work without desktop capability. No automatic desktop
  input or screen capture occurs during diagnosis.
- Checking old Workers returns an explicit v0.1.4 upgrade requirement. Existing
  execution remains unchanged. Deleted Workers' open event streams terminate.

## Scope and complexity review

New paths correspond to concrete states: no config/existing config; current/remote
installation; pending/approving/approved/expired/rejected authorization;
queued/delivered/completed/timed-out checks; and required platform commands.
They are localized in the onboarding module, Worker setup module and dedicated
UI rather than adding state to model inference or tool history.

Compatibility owner: Cybion maintainers. The diagnostic version guard supports
installed pre-v0.1.4 Workers; remove only after the supported minimum and an
active/stored-version audit permit it, preserving the version regression test.
The existing manual-pairing API/config format remains an explicitly supported
advanced interface, not an automatic fallback. Worker Windows tar.gz is retained
for old installers until their minimum supported version is raised; ZIP is the
recommended UI format. No token is copied into browser persistence.

Deferred: OS service installation, signed native installers, automatic OS permission
changes, actual interactive browser/desktop tests, and onboarding funnel analytics.
Background mode is labeled honestly as distinct from reboot persistence.

## Verification and release

- Rust unit and HTTP tests: ownership, simultaneous approval, token secrecy,
  authentication, expiry, cancellation, idempotency/revocation, rate limits and
  actual SSE/result routes.
- Worker tests: no-clobber private configuration, exclusive process lock,
  resumable device credentials near expiry, cancellation, safe capability checks.
- Frontend tests: manifest/commands, exact-device readiness, consent and no token
  persistence. Playwright covers approval, refresh, first-task handoff, mobile
  remote installation in both languages, expiry and timeout recovery.
- `scripts/test-worker-roundtrip.py /path/to/cybion-worker` runs the real Worker
  against an authenticated disposable controller fixture; checks background
  startup, diagnostic round trip, duplicate process rejection and revocation exit.
- Publish Worker v0.1.4 before Controller v0.3.54. Controller release checks all
  recommended Worker assets/checksums before publishing, then runs public
  onboarding smoke after deployment. That smoke never approves a device and
  leaves one short-lived request to expire.
