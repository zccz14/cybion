# Cybion

Cybion is the hosted AI execution service at
[`cybion.ntnl.io`](https://cybion.ntnl.io). Each signed-in Auth Mini user owns
isolated conversation threads, integrations, API keys, and paired Workers.

Each user is stored in one SQLite database:

```text
~/.cybion/users/<auth-mini-user-id>.sqlite3
```

The databases use WAL mode, foreign keys, and owner-only file permissions.

Administrator metadata is stored separately in `~/.cybion/default.sqlite3`.
Its `app_meta` table contains the single `root_user_id` key used to expose the
administrator navigation and system resource monitor. On a fresh installation,
the first authenticated browser session initializes that key atomically.

## Product boundary

- Auth is fixed to `https://auth.ntnl.io`. The browser obtains one token for
  `cybion.ntnl.io`, `linkit.ntnl.io`, and `openai.ntnl.io`; each service checks
  its own audience.
- Controller restarts automatically resume `running` Threads from committed
  history and original Worker calls. Transient model failures retry within a
  persisted five-attempt budget; stopped/completed Threads stay stopped.
- Threads are independent. A user can create, rename, inspect, and delete
  them from the web UI.
- Configuration lets each user save the default model, reasoning effort,
  Fast mode, and the context budget for new threads. These defaults are
  stored in the user's database and apply to both web and API creation. An
  explicit API `model` overrides the default model; existing threads keep their
  own settings. The context budget is the token threshold for proactive
  compaction; each thread may override it, `0` disables it, and the built-in
  default is 200,000. Threads without an override follow later default changes.
- Thread turns always include the `web_search` and `image_generation` native
  tools in the inference request to the configured provider.
- `tools.json` is the single source for the upstream tool catalog. The request
  builder sends it and the Configuration → Tools page renders it, so the
  capability list cannot drift from the tools a Thread can actually use.
- `history_records` is the append-only per-thread protocol log. It stores the
  user input, every upstream Responses output item, Worker output, checkpoint,
  and activity record. The auto-incrementing `history_records.id` is the record
  index and the sole context ordering key.
- Before each Responses request, Cybion reads the same thread's latest
  checkpoint at or before the selected record index, then replays the remaining
  protocol records in index order. A fresh request therefore reconstructs its
  context from SQLite rather than an in-memory conversation or an upstream
  response chain.
- Threads keep a context budget: before inference, an estimated replayed
  context above the effective budget is compacted into a fresh checkpoint, so
  long threads never reach the upstream window before compacting. The
  conversation header shows the latest inference context size against that
  budget.
- **Configuration → Responses-compatible upstreams** lets each user manage
  several named upstreams, each with its own `base_url` and `api_key`. Keys are
  stored in that user's SQLite database and are never returned to the browser.
  Cybion sends model requests to `{base_url}/responses` of the upstream a Thread
  selected, preserving the existing streaming, tool-call, context replay, and
  audit behavior. Each upstream owns its model catalog: Cybion reads
  `GET {base_url}/models` per upstream, and the Configuration page lists every
  catalog while the new-thread, thread, and defaults model pickers group the
  catalogs by upstream name. A Thread keeps its own upstream and model
  selectable even after a catalog stops reporting it, and an upstream that
  Threads or defaults still reference cannot be deleted. Schema 16 converts the
  single legacy configuration (an explicit key, or an OpenAI-LB consumer
  credential) into one upstream and binds existing Threads to it.
- Linkit task notifications are optional and configured separately. They do not
  gate model inference, external API requests, or API-key creation.
- **Configuration → Linkit task notifications** lets the owner enable/repair,
  pause, and test notifications. Bot credentials are checked using Linkit's
  current user APIs; stale Bot tokens can be rotated without replacing a healthy
  Bot. Notifications use `POST /api/conversations/direct/{username}` followed by
  `POST /api/conversations/{id}/messages`. The stable recipient UUID is verified
  before sending Thread content. The removed `/bot/v1/messages` route is not used.
- Delivery results persist per user, including the last error and successful
  conversation/message receipt. Delivery failure does not change the Thread
  outcome. Sends have a 15-second per-request timeout and are not blindly retried
  because message creation is not idempotent. A receipt means stored in Linkit,
  not device push or human read confirmation. Successful inference and terminal
  failures notify; cancelled/superseded requests and successful compaction do not.
- New users start with notifications off. Schema 14 preserves notification
  intent for existing users with saved Bot credentials. Pausing retains those
  credentials and the remote Bot; a manual test does not turn notifications on.
- A paired Worker performs Bash, Browser Control, and Computer Use on the
  user's device. It keeps no model credential or SQLite database.

## Integration API

Create an API key in the Cybion UI. The key is scoped to one Auth Mini user and
is shown only once:

```sh
export CYBION_API_KEY='cyb_<user-id>_<secret>'
curl -X POST https://cybion.ntnl.io/v1/threads \
  -H "Authorization: Bearer $CYBION_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Summarize the release","model":"gpt-5.6-terra"}'
```

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/threads` | Create a thread. |
| `GET` | `/v1/threads/{id}` | Read thread metadata and request state. |
| `GET` | `/v1/threads/{id}/history` | Read every durable record in index order. |
| `POST` | `/v1/threads/{id}/inputs` | Append input and start inference. |

`POST /v1/threads/{id}/inputs` accepts `{"input":"..."}` and returns the
new `record_idx`. Poll the thread and history endpoints for the result.

The [History table](docs/history.md) at `#/history` exposes stored history rows
with server-side filters, sorting, pagination, and full raw-field inspection.

## Cybion Worker

The standalone Worker is published from `zccz14/cybion-worker` for macOS,
Linux and Windows. Open **Workers → Connect a device**, select the target
platform, then download, extract and start Worker:

```sh
./cybion-worker run --background
```

On Windows PowerShell use `.\cybion-worker.exe run --background`. With no config,
Worker opens browser authorization and prints a short-lived pairing code for
headless devices. Match the device/code and explicitly authorize in Cybion;
configuration is written on the device automatically. The guide verifies task
delivery, fixed command execution and result upload before reporting readiness.
Existing configuration is reused. Worker 0.2.x keeps call deduplication and
result retries in memory across network reconnects, and 0.2.1 adds delivery
receipts so acknowledged calls are not replayed; Worker restarts may lose
state. The device page shows the reported version and lets the owner request
a newer recommended official release after current work drains. A 0.1.x Worker
needs a one-time manual installation of 0.2.x. Background mode does not install automatic
startup. `status`, `doctor` and the guide provide diagnostics and recovery.

See [Worker onboarding](docs/worker-onboarding.md) for the protocol, security,
capability limits, manual configuration and release/test procedures.

## Development and release

```sh
npm --prefix web ci
npm --prefix web run check
npm --prefix web run build
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

The release binary embeds `web/dist` and targets Linux x86_64 for the hosted
controller. Production state is under `/root/.cybion`. The current schema uses
`users/`; databases from the earlier hosted layout are intentionally not
migrated and are outside this release's data set. New user databases are
created on first use.

Pushing a `v*` tag publishes the binary and invokes the AWS Systems Manager
deployment job. The repository variables are `AWS_DEPLOY_ROLE_ARN`,
`AWS_REGION`, and `EC2_INSTANCE_ID`.
