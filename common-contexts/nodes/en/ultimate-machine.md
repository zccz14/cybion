# Ultimate Machine

An Ultimate Machine = one Worker + one bash check command + one run interval. It runs on schedule: exit 0 and it stays silent; on failure, the controller delivers the repair request into its bound repair Thread (titled 「终极机器 · <name>」).

The name comes from the Bell Labs desk box whose only function is to switch itself off. These machines carry on the same joke: quiet by default, they appear only when a check fails, and fall silent again once the command returns 0.

## Key semantics

- **Scheduling**: the first run starts right after creation; after that, each run starts one interval after the previous run settles (a slow command lengthens the real period), and at most one run is in flight per machine.
- **Failure**: exit ≠ 0 (or the command is killed) → the repair Thread receives a user message: the command, exit, output tail, intent (if any), and the success criterion "make the command return 0".
- **Offline**: if the Worker is offline or gone at run time → skip this run and alert once through Linkit; stay quiet during a long outage; resume automatically once it recovers (each offline event alerts once).
- **Lost**: a run that does not settle within 15 minutes (device died mid-run, etc.) → declared lost, one alert, retried at the next interval.
- **Dropped messages**: while the repair Thread is mid-turn, a new failure message is dropped (not queued) — it is reconsidered after the next run settles; silence therefore means neither good health nor a dead machine.
- **Lifecycle**: deleting the bound repair Thread or the Worker it uses deletes the machine with it; rebinding to another Worker restarts the offline-alert episode (treated as a new one).

## When to create one

The Ultimate Machine fits **long-lived conditions that can be judged "healthy" automatically**:

- Resource levels: root / data disk usage, free inodes, memory and swap occupancy.
- Expiry: TLS certificate days remaining, backup windows, disk quotas.
- Service liveness: a local port accepts connections, a systemd unit is active, a key process exists.
- Data freshness: the "last success" timestamp left by a sync job is within its allowed window.
- Consistency: key files exist and are non-empty, checksum matches expectation.

Not suitable:

- One-off tasks, or anything that needs human judgment.
- High-frequency polling — the minimum interval is 10 seconds, and most checks are fine at minute-to-hour granularity.
- Cases that need the repair action itself: the machine only discovers; the repair happens in the bound Thread.
- Output that may contain secrets, tokens, or private data: the failure output tail enters the Thread history.

Entry points: users can create machines on the Ultimate Machines page (choose a Worker, fill in the command and interval); when a user asks, you can also create one directly with `cybion_set_ultimate_machine` (see "Management tools" below). The unchanging rule: dry-run the command with bash on the target Worker first.

## Writing the check command

Guidelines:

- **The exit code is the semantics**: 0 = healthy and silent; any nonzero = failure, and the tail of stderr/stdout (~1500 characters) goes into the repair Thread. Let failures speak for themselves.
- **Read-only and idempotent**: repeated runs must not change state or leave side-effect files.
- **Cheap**: each run is capped at 300 seconds (timed by the Worker; a run killed by the timeout counts as a failure); a millisecond-fast read is best.
- **Do not rely on the login environment**: write it for a non-interactive shell (explicit paths, no dependence on shell profiles); mind Worker OS differences (macOS and GNU tools behave differently).
- **Actionable on failure**: include the expected value and the current value so the fixer does not need a second investigation.

Examples:

- Root disk usage < 90%:
  `test $(df -Pk / | awk 'NR==2 {print $5}' | tr -d %) -lt 90`
- Certificate not expiring within 7 days (exits 0 when not near expiry):
  `openssl x509 -checkend 604800 -noout -in /etc/ssl/certs/server.pem`
- A new backup file within 24 hours:
  `find /backups -maxdepth 1 -type f -mmin -1440 | grep -q .`

Dry-run it first: use the bash tool to run the same command on the target Worker — confirm it returns 0 when healthy, then force a failure and check that the output is readable.

## Management tools (the tool suite)

Three tools manage Ultimate Machines: `cybion_list_ultimate_machines`, `cybion_get_ultimate_machine`, `cybion_set_ultimate_machine`. Field-level semantics follow the tool descriptions; here are the usage patterns.

### Which one to use

- **Overview and ids**: `cybion_list_ultimate_machines` — every machine's definition plus its latest settled result (`enabled`, `last_run_at`, `last_exit`, the bound repair Thread).
- **One machine in detail**: `cybion_get_ultimate_machine` — `last_exit`: 0 = healthy; any other number = the exit code (killed without one counts as -1); null = no settled result yet (or the latest run never completed / was declared lost).
- **Create or update**: `cybion_set_ultimate_machine`.

### Create (omit machine_id)

Required: `name`, `worker_id`, `command`, `interval_seconds` (10–2592000); optional: `intent`.

- You can only bind Workers **you own** (shared Workers cannot run machines); if unsure, call `cybion_list_workers` first.
- The first run starts right after creation, and a repair Thread "终极机器 · <name>" is created automatically.
- Dry-run first: run the same command with bash on the target Worker; confirm it returns 0 when healthy and that failure output is readable.
- Typical request "add a disk check to MacMini": list_workers → bash dry-run → set to create → confirm to the user in one sentence; do not paste the whole thing.

### Update (with machine_id, partial)

- Pass only the fields you want to change; everything else stays put.
- An empty `intent` clears it; omit it to keep it.
- `enabled: false` pauses, `true` resumes (new machines start enabled; `enabled` can only be passed on update).
- Changing `worker_id` moves the machine and restarts the offline-alert episode.
- Renaming retitles the repair Thread (unless its title was renamed by hand).
- The suite has no delete: pause to stop; complete removal is deleting the bound repair Thread or the Worker it uses.

Machines are the user's assets: create or update them only when the user asks or a repair requires it; describe the plan before batch actions.

## After a failure

The repair Thread receives a message like:

```text
【终极机器·磁盘检查】在 Worker「MacMini」上执行失败：exit=1。

意图：
确保根分区低于 90%

命令：
test $(df -Pk / | awk 'NR==2 {print $5}' | tr -d %) -lt 90

输出尾部：
...
请修复，使该命令返回 0；修好后无需回复，下次运行会自动验证。
```

Workflow:

1. **Read the definition and evidence**: first use `cybion_get_ultimate_machine` for the definition and latest result; then read the command, exit, and output tail from the message; the intent says what this machine protects.
2. **Decide where the problem is**:
   - Environment problem (the disk really is full, the certificate really expired, the service is down) → fix it directly with bash on that Worker.
   - The check itself is wrong (the path changed, the command is incompatible with the system) → verify the corrected command with bash first, then update the machine definition with `cybion_set_ultimate_machine`; if the tool is unavailable, ask the user to edit it on the Ultimate Machines page.
3. **Verify**: run the corrected command by hand and confirm it returns 0.
4. **Do not weaken the check just to turn it green**: quietly loosening what exit 0 means equals losing the machine.
5. **No reply needed**: the next run verifies automatically; continued silence afterward means the repair worked.

## Boundaries and pitfalls

- **Pause ≠ delete**: `enabled=false` (or passing `enabled=false` to `cybion_set_ultimate_machine`) only pauses; for complete removal, delete the bound repair Thread or the Worker it uses.
- **Secrets**: failure output enters the Thread history — do not echo keys/tokens; if you must test whether a token is valid, output a boolean only.
- **Environment differences**: commands run in the Worker's execution environment; do not assume a uniform PATH, locale, or timezone.
