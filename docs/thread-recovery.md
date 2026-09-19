# Thread recovery and Worker 0.2.0

`threads.status` is the execution switch. Startup and a five-second supervisor
scan resume `running` Threads that have no live process-local cancellation
receiver. Input/control history record IDs remain the stale-response fence;
there is no new execution table, identifier, or durable Worker queue.

Recovery first settles saved tool calls, then compiles the latest committed
history. It never rewinds to the initial input before already-executed tools.
Complete model call items and valid Worker jobs commit together. Successful
model completion snapshots and terminal Thread status commit together. Manual
compaction commits its checkpoint and idle status together. Errors in a model
stream no longer invent failures for Worker commands already dispatched.

Connection failures, HTTP 408/429/5xx, idle/closed streams, rate limiting and
provider overload retry with backoff. HTTP authentication/invalid-request/quota
failures do not. Retry-After and the retry count/next time survive Controller
restarts. Five consecutive failed attempts exhaust the budget; completed model
responses reset it. Retry waits and stale operations respect cancellation.
Linkit notifications are optional; inference requires only model credentials.

## Worker delivery

0.2.0 sends `x-cybion-worker-boot-id` and `x-cybion-worker-version` when connecting.
One process keeps its boot ID and in-memory call-ID fingerprints across SSE
reconnects. An executing call is never dispatched twice by that process; a
finished result retries upload without rerunning the command. Acknowledged
result payloads are released, while fingerprints remain for the process's life.

Controller binds a call to a boot before dispatch. A reconnect by that boot may
replay delivered calls. A new boot fails only the old boot's unresolved delivered
calls with `worker_restarted` / `execution_outcome: unknown`; previously queued
calls may be assigned to the new boot. Lost results never imply that side effects
did not occur. Late actual results are audit activity and cannot rewrite a tool
output already passed to the model. A still-offline Worker is waited for rather
than guessed dead after a network timeout; users can stop the Thread.

0.1.x Workers temporarily retain single-delivery behavior during rollout. Their
unbound delivered calls must not be replayed into a fresh 0.2.0 process. Remove
this compatibility path once the supported minimum is 0.2.0 and all unbound
calls have settled. Worker process crashes can lose its in-memory state; there
is no task journal, disk outbox or cross-process execution guarantee.

## Owner-managed upgrades

The authenticated owner requests `POST /api/workers/{id}/upgrade`. The target is
always the Controller's embedded `worker-release.json`, never a client-supplied
version or URL. Only online, boot-aware Workers older than that recommendation
are eligible. Requests are stored on the existing worker row and visible in
list/read/rename responses as version, capability and upgrade status.

Queued upgrades pause new calls and wait for delivered calls/diagnostics to
finish. The SSE `upgrade` event is bound to the current boot. Worker waits for
all execution/upload futures, verifies the official repository's platform
archive SHA-256 and the staged executable's version, keeps the previous binary,
replaces itself, releases its config lock and starts the new executable. All
platforms use the official `.tar.gz` for self-updates; Windows ZIP is an
additional manual-install format. No arbitrary model tool or URL can request
this control operation.

The new process reports its actual version in the initial task-channel handshake.
Only that report (or a heartbeat) confirms completion. Download/checksum/preflight
errors leave the current process in service. An early replacement startup failure
restores the previous executable; a new boot reporting the old version marks the
pending install failed rather than triggering an upgrade loop. Installation
archives/previous executables are not persisted task state. Executable-directory
write permission is required. Power loss/disk failure is not an atomic upgrade
or rollback guarantee.

0.1.x has no self-update handler: install 0.2.0 manually once. Subsequent updates
can be initiated by Controller. A Worker newer than the recommendation is never
automatically downgraded.

## Validation

Run ordinary Rust/frontend tests plus:

```sh
bash scripts/test-thread-recovery.sh
```

The smoke test builds an isolated fixture from the recommended Worker tag and
uses production Controller/Worker loops in separate test processes. Test-only
entry points permit synthetic loopback configuration without weakening production
HTTPS requirements or touching an existing service. It kills its own Controller
while a harmless gated command runs, lets that command finish during the outage,
then restarts Controller. Assertions require one command execution, one tool
output, one user input, the same Worker boot, and automatic Thread completion.
All databases, credentials, marker files and processes are test-local.
