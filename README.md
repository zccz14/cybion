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
  `cybion.ntnl.io`, `linkit.ntnl.io`, `openai.ntnl.io`, `ctx.ntnl.io`, and
  `normai.ntnl.io`; each service checks its own audience. The Auth Mini
  provider deletes a session whose token does not cover every audience and
  re-logs in — a login mints audiences once and refresh keeps them — so the
  flow re-mints a complete session before the automatic NormAI connect runs.
- Controller restarts automatically resume `running` Threads from committed
  history and original Worker calls. Transient model failures retry within a
  persisted five-attempt budget; stopped/completed Threads stay stopped. A
  delivered Worker call that outlives its own timeout is cancelled on the
  Worker; when no confirmation arrives within 30 seconds the Controller
  answers the call itself with an outcome-unknown
  `timeout_cancel_unconfirmed` failure that asks the model to clean up a
  possibly leaked execution before continuing.
- Threads record their creation origin: `web` for the browser and `api` for
  `/v1/threads` calls, where the creating API key id is stored and an optional
  caller-supplied `external_ref` can map the Thread to the integration's own
  identifier. The web UI marks API Threads in the thread list and header.
- Threads are independent. A user can create, rename, inspect, archive, and
  delete them from the web UI. Archiving hides a Thread from the thread list
  without deleting its history; archived Threads stay readable, remain
  available through the archived group, and can be restored from the list or
  the conversation header.
- Owners can grant another Cybion user read-only access to a Thread, whether or
  not the recipient has signed in before: a share silently creates their account
  and waits at their first sign-in.
  **Share Thread** picks the recipient from the Linkit directory; **Shared with
  me** shows received live shares. History and future updates are included, without granting model,
  Worker, Context, account-audit or API-key access. Revocation blocks new source
  reads independently of discovery sync; already read/copied content cannot be
  recalled. See [Thread sharing](docs/thread-sharing.md).
- The optional CTX integration (Configuration → Integrations) mints a labeled
  API key inside CTX (ctx.ntnl.io) with the browser session and stores it in
  the user's database. While connected, `cybion_list_contexts` appends the
  user's top-level CTX documents to the top-level Context list and
  `read_context` reads those documents (current revision plus direct
  sub-documents); a failing CTX call degrades the list with a `notice` and
  answers reads with a tool `error` instead of failing the turn.
- The thread list filters and paginates on the server. `GET /api/threads`
  accepts `status` (`idle`, `running`, `failed`), `origin` (`web`, `api`),
  and `q` (case-insensitive substring of the title or `external_ref`) next to
  `archived`, plus `limit` (1-100, default 30) and a keyset `cursor` returned
  as `next_cursor`. The web UI exposes them through one control bar that
  opens on Web (the user's own web Threads) with single-select All / Web /
  API / Running / Failed view chips and a debounced search box; the selection
  lives in the page URL, so it is shareable, survives reloads, and steps with
  browser back/forward. More pages load when the list footer scrolls into
  view; the archived group stays outside the filter.
- Configuration lets each user save the default model, reasoning effort,
  Fast mode, and the context budget for new threads. These defaults are
  stored in the user's database and apply to both web and API creation. An
  explicit API `model` overrides the default model; existing threads keep their
  own settings. The context budget is the token threshold for proactive
  compaction; each thread may override it, `0` disables it, and the built-in
  default is 200,000. Threads without an override follow later default changes.
- The conversation supports a minimal mode that folds every turn down to its
  input plus one tail item: the turn's last AI reply or its last activity
  line, whichever came later; all other replies, activities, and protocol
  records stay collapsed, while the turn's images (generated images and
  ledger-marked screenshots) surface as one image group with the tail item.
  The personal default lives in Configuration →
  Personal settings; a per-thread override in the thread settings takes
  precedence. It is a display preference stored with the user's settings, and
  it changes neither inference nor history records.
- Thread turns always include the `normai_web_search` and
  `normai_image_generation` tools. The Controller intercepts both: web search
  requests the Thread's search endpoint (`POST {upstream}/web-search`; the
  hosted gateway routes the pinned `deepseek` source to a load-balancing
  upstream) and answers the model with the result sources; image generation
  requests the Thread's image endpoint (`POST {upstream}/images/generations`;
  the hosted gateway routes it to the OpenAI LB image catalog) and appends the
  generated image to the Thread. Models without either native tool (for
  example DeepSeek) use both capabilities through the same path.
- `tools.json` is the single source for the upstream tool catalog. The request
  builder sends it and the Configuration → Tools page renders it, so the
  capability list cannot drift from the tools a Thread can actually use.
- [Custom Tools](docs/custom-tools.md) extend that catalog with declarative
  controller-side integrations: each connector declares its base URL,
  credential references, per-tool request bindings and response projections,
  and the generic executor handles routing, credential injection, settlement
  and rate limiting without per-integration code. Linkit is the first
  connector.
- `history_records` is the append-only per-thread protocol log. It stores the
  user input, every upstream Responses output item, Worker output, checkpoint,
  and activity record. The auto-incrementing `history_records.id` is the record
  index and the sole context ordering key.
- The composer accepts pasted images (png/jpeg/webp/gif, at most 4 per input).
  The browser downsizes larger files, the input record stores each image as an
  `input_image` data URL next to the typed text, and replay sends it to the
  model unchanged. Text inputs stay plain strings.
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
- Every user gets a **NormAI** upstream (normai.ntnl.io) automatically. On
  the first workspace load the controller issues — or rotates, when the user
  already owns a `Cybion` consumer — a consumer credential through NormAI's
  user API with the browser session, stores the key as the user's `NormAI`
  upstream, and binds it as the default upstream while no other default was
  chosen. Upstream providers and billing live on NormAI; the Configuration
  page links there and can reissue the credential (normai.ntnl.io/#/providers).
- The NormAI card keeps the manual fallback surface: **Fallback upstreams**
  opens a dialog — only needed while NormAI is unavailable — where each user
  manages several named Responses-compatible upstreams, each with its own
  `base_url` and `api_key`. Keys are stored in that user's SQLite database and
  are never returned to the browser. Cybion sends model requests to
  `{base_url}/responses` of the upstream a Thread selected, preserving the
  existing streaming, tool-call, context replay, and audit behavior. Each
  upstream owns its model catalog: Cybion reads `GET {base_url}/models` per
  upstream, and the model pickers group the catalogs by upstream name. A
  Thread keeps its own upstream and model selectable even after a catalog
  stops reporting it, and an upstream can be deleted even while Threads or
  defaults still reference it — those Threads fail at their next use until
  the owner points them at another upstream. Schema 16 converts the single
  legacy configuration (an explicit key, or an OpenAI-LB consumer credential)
  into one upstream and binds existing Threads to it.
- Linkit task notifications ride on an automatically maintained Linkit
  connection — the owner's username, an owned `Cybion` Bot, and a valid Bot
  token — and stay independent of model inference, external API requests, and
  API-key creation. Every workspace load silently ensures that connection,
  repairing stale credentials to completion without replacing a healthy Bot.
- **Configuration → Linkit task notifications** exposes the notification
  switch, the recipient and delivery status, and **Send test notification**. A
  **Repair connection** button appears only while the connection is incomplete
  (for example, before the owner sets a Linkit username). Bot credentials are
  checked using Linkit's current user APIs. Notifications use
  `POST /api/conversations/direct/{username}` followed by
  `POST /api/conversations/{id}/messages`. The stable recipient UUID is verified
  before sending Thread content. The removed `/bot/v1/messages` route is not used.
- Delivery results persist per user, including the last error and successful
  conversation/message receipt. Delivery failure does not change the Thread
  outcome. Sends have a 15-second per-request timeout and are not blindly retried
  because message creation is not idempotent. A receipt means stored in Linkit,
  not device push or human read confirmation. Successful inference and terminal
  failures notify; cancelled/superseded requests and successful compaction do not.
- New users start with notifications off; the switch is the only notification
  control and never triggers the connection ensure. Schema 14 preserves
  notification intent for existing users with saved Bot credentials. Switching
  notifications off retains those credentials and the remote Bot; a manual test
  does not turn notifications on.
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

`POST /v1/threads/{id}/inputs` accepts
`{"input":"...","images":["data:image/png;base64,..."]}` and returns the new
`record_idx`; `images` is optional, and each entry must be a png/jpeg/webp/gif
base64 data URL. Poll the thread and history endpoints for the result.

The [History table](docs/history.md) at `#/history` exposes stored history rows
with server-side filters, sorting, pagination, and full raw-field inspection.

## Cybion Worker

The standalone Worker is published from `zccz14/cybion-worker` for macOS,
Linux and Windows. Downloads and checksums are served through the Controller
(`/worker-release/…`, a mirror of the official release assets) so devices on
networks that cannot reach GitHub can still install and upgrade. Open
**Workers → Connect a device**, select the target platform, then download,
extract and start Worker:

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
state. Worker 0.2.7 aborts a call the Controller cancels: a running Bash or
Computer Use process tree is terminated and a queued execution never starts.
The device page shows the reported version and lets the owner request
a newer recommended official release after current work drains; Worker 0.2.4+
downloads those upgrades through the same mirror with a direct GitHub fallback,
so a device that cannot reach GitHub installs 0.2.4 once through the
Controller-served download and upgrades remotely from then on. A 0.1.x Worker
needs a one-time manual installation of 0.2.x. Background mode does not install automatic
startup. `status`, `doctor` and the guide provide diagnostics and recovery.

Owners can share a Worker with an existing Cybion user for `bash`,
`browser_control`, and `computer_use`. Recipients use their own Threads and model
configuration. Authorization and call audit remain in the owner's database;
discovery and tool outputs are stored in the recipient's database. See
[Worker sharing](docs/worker-sharing.md) for the APIs, cancellation and
revocation semantics, schema migration, recovery, and storage/retention limits.

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
