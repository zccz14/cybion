# Cybion

Cybion is the hosted, multi-tenant AI execution service at
[`cybion.ntnl.io`](https://cybion.ntnl.io). A signed-in user owns an isolated
set of flat conversation threads, API keys, integrations, and paired Workers.

There is no main thread, subthread, Goal scheduler, shared Cybion user table,
or cross-tenant transaction. Each Auth Mini subject maps to one physical SQLite
database:

```text
~/.cybion/tenants/<sha256(auth-mini-subject)>.sqlite3
```

Tenant databases use WAL mode, foreign keys, and owner-only file permissions.

## Product boundary

- Auth is fixed to `https://auth.ntnl.io`. The browser requests one access token
  with audiences `cybion.ntnl.io`, `linkit.ntnl.io`, and `openai.ntnl.io`; each
  downstream service verifies its own audience without knowing Cybion's context.
- Every thread has its own direct input stream and independent persistent
  history. Users create, rename, and delete their own threads in the web UI.
- On first use, Cybion creates a user-owned Consumer through the existing
  `openai.ntnl.io/api/consumers` API; request usage and billing remain attributed
  to that Auth Mini subject in OpenAI-LB.
- The same first-use flow creates a user-owned Linkit Bot through the existing
  `/api/me` and `/api/bots` APIs. A run completion or failure is delivered to the
  user's private direct conversation through `/bot/v1/messages` and Linkit's
  existing Bark/APNs path. The Linkit profile must have a username before the
  first run; Cybion reports that prerequisite directly if it is missing.
- A paired Worker performs Bash, Browser Control, and Computer Use on a
  personal device. It connects out to Cybion over HTTPS/SSE and keeps no local
  SQLite database or model credential.

## Integration API

Create an API key in the Cybion UI. It is shown once and is scoped to exactly
one tenant. Send it as a Bearer credential:

```sh
export CYBION_API_KEY='cyb_<tenant-id>_<secret>'
curl -X POST https://cybion.ntnl.io/v1/threads \
  -H "Authorization: Bearer $CYBION_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Summarize the release","model":"gpt-5.6-terra"}'
```

The hosted API is intentionally small:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/threads` | Create a flat thread. |
| `GET` | `/v1/threads/{id}` | Read its model and run state. |
| `GET` | `/v1/threads/{id}/history` | Read its ordered durable history. |
| `POST` | `/v1/threads/{id}/inputs` | Append a human or application input and start a run. |

`POST /v1/threads/{id}/inputs` accepts `{"input":"..."}` and returns the
queued run. Poll the thread and history endpoints for its terminal state and
output. API keys never select another tenant, even when their route segment is
modified.

## Cybion Worker

The standalone Worker is published from
[`zccz14/cybion-worker`](https://github.com/zccz14/cybion-worker) for macOS
arm64/x86_64, Linux x86_64/aarch64, and Windows x86_64. Create a pairing in the
Cybion UI, save the emitted file as `~/.cybion/worker.toml`, then run:

```sh
cybion-worker run --background
```

The Worker reports a heartbeat and machine resources, receives tool calls over
SSE, and returns each result by HTTPS. It uses an existing Chrome, Chromium, or
Edge DevTools endpoint for Browser Control and the platform's desktop
automation facility for Computer Use.

## Development and release

```sh
npm --prefix web ci
npm --prefix web run check
npm --prefix web run build
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

The Cloud release builds only a Linux x86_64 binary because it runs on the
Tokyo EC2 host. The binary embeds `web/dist`, so rebuild the frontend before a
release build. Production state remains under `/root/.cybion`; the current
service never reads or migrates the legacy single-tenant `default.sqlite3`.

Pushing a `v*` tag runs the release CD job after publishing the asset. The job
assumes the repository's AWS OIDC deployment role and uses Systems Manager to
update the Tokyo instance behind `cybion.ntnl.io`; its repository variables are
`AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, and `EC2_INSTANCE_ID`.
