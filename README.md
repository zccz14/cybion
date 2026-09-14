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
- Threads are independent. A user can create, rename, inspect, and delete
  them from the web UI.
- Configuration lets each user save the default model, reasoning effort, and
  Fast mode for new threads. These defaults are stored in the user's database
  and apply to both web and API creation. An explicit API `model` overrides the
  default model; existing threads keep their own settings.
- `history_records` is the append-only per-thread protocol log. It stores the
  user input, every upstream Responses output item, Worker output, checkpoint,
  and activity record. The auto-incrementing `history_records.id` is the record
  index and the sole context ordering key.
- Before each Responses request, Cybion reads the same thread's latest
  checkpoint at or before the selected record index, then replays the remaining
  protocol records in index order. A fresh request therefore reconstructs its
  context from SQLite rather than an in-memory conversation or an upstream
  response chain.
- On first use, Cybion provisions a user-owned OpenAI-LB Consumer and Linkit
  Bot. Completion and failure notices are sent to the user's private Linkit
  conversation.
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

## Cybion Worker

The standalone Worker is published from
[`zccz14/cybion-worker`](https://github.com/zccz14/cybion-worker) for macOS,
Linux, and Windows. Create a pairing in the Cybion UI and save the returned
configuration as `~/.cybion/worker.toml`:

```toml
controller_url = "https://cybion.ntnl.io"
user_id = "..."
machine_id = "..."
access_token = "..."
```

Run it with:

```sh
cybion-worker run --background
```

The Worker reports liveness and resources, receives calls over SSE, and posts
results over HTTPS.

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
