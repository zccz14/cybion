# Custom Tools

Custom Tools let Cybion threads call external services through **curated,
declarative tools** that the Controller executes on the user's behalf. A
connector is a block of data (`tools.json` → `custom_tools`); the generic
runtime in `src/cloud/custom_tools.rs` owns routing, credential injection,
request building, response projection, idempotent settlement and rate
limiting. Adding a connector must not require touching the dispatcher, the
request builder, the recovery loop or the web app — only the catalog entry and
its tests.

This is what keeps the hosted service on one codebase while integrations grow
as data. Linkit is the first connector (see “Current connectors”).

## Why not hand the model HTTP directly

- **Credentials never leave the trust boundary.** Tokens live in the user
  database and Controller memory; they are injected into the outbound request
  and never appear in tool schemas, tool results, `history_records`, logs, API
  responses, or user devices (Workers).
- **Curated surface, not passthrough.** The reachable request surface is
  exactly the declared method + path templates + parameter placements. There
  is no `custom_request(method, url)` escape hatch, no SSRF surface, and the
  audit answer to "what can this integration do" is the declaration itself.
- **Deterministic settlement.** Side-effecting tools run under a durable
  ledger (`custom_tool_calls`) that survives crashes: a call is marked before
  it is sent, settled after, and replayed calls are reused — a resend never
  happens implicitly.

## Declaration reference

`tools.json` gains a `custom_tools` object keyed by connector id; the request
builder and the Configuration → Tools page read the same file, preserving the
single-source invariant.

### Connector level

| Field | Required | Notes |
|---|---|---|
| `title{en,zh}` | en | Display name for the Tools page (Custom Tools group). |
| `base_url` | yes | Production base URL. Tests override it at the deployment level; declarations keep the production value. |
| `auth` | yes | `scheme`: `bearer` / `header` / `query`; `secret`: a credential reference (below). `header` accepts `name` and a `format` with a `{secret}` placeholder. |
| `available_when` | yes (may be `[]`) | Credential references that must all be present for the user, otherwise the connector's tools are **not injected** (the model never sees unusable tools). |
| `limits.per_minute` | no | Per-user call budget (sliding 60 s window, process-local). Over-budget calls are answered with a rate-limit error. |
| `tools` | yes | One or more tool declarations. |

Credential references (used by both `auth.secret` and `available_when`):

| Form | Meaning |
|---|---|
| `{"store":"integration_settings","field":"<column>"}` | Managed credentials written by an existing onboarding flow (for example the Linkit bot token). |
| `{"store":"custom_tool_settings","key":"<key>"}` | Self-serve credentials in the per-user `custom_tool_settings` table. |

### Tool level

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `function` (the only kind). |
| `name` | yes | Globally unique; must start with `<connector id>_`; validated by tests. |
| `title{en,zh}` | en | Tool label on the Tools page; user-language selection with a fallback to `en` and then the raw name. No hardcoded web edits. |
| `description` | yes | Model-facing English guidance: when to use, and when not to. |
| `parameters` | yes | JSON Schema (`type: object`, `additionalProperties: false`). Every declared parameter must be consumed by exactly one binding slot. |
| `binding` | yes | Request mapping, below. |

### Binding

| Field | Required | Notes |
|---|---|---|
| `method` | yes | `GET` / `POST` / `PUT` / `PATCH` / `DELETE`. |
| `path` | yes | Relative template starting with `/`; `{name}` placeholders must match `path_params`. |
| `path_params` | — | Parameter names injected into the path. Values are percent-encoded and may not be empty, control characters, `.` or `..`. |
| `query` | — | Parameter names appended to the query string (same name). |
| `body` | — | Parameter names placed into the JSON body. |
| `defaults` | — | Fallback values for omitted parameters (for example `{"urgent": false}`). |
| `body_constants` | — | Fixed body fields that are never exposed as parameters. |
| `effect` | yes | `read` (no side effect; safe to retry) or `send` (side effect; settled). |
| `settlement` | for `send` | `{"strategy":"mark_then_send"}` or `{"strategy":"provider_key","idempotency":{"header":"Idempotency-Key","value_from":"call_id"}}` — the latter sends the model call id as the provider's idempotency key. |
| `result.projection` | yes | Response whitelist (below). |
| `timeout_seconds` | no | Default 15, clamped to 60. |

### Response projection (deny by default)

Two forms, no expression language:

```json
"result": { "projection": {
  "message_id": "id",
  "conversations": { "list": "conversations",
    "pick": { "id": "id", "title": "title", "kind": "kind" } }
} }
```

- `"field": "dot.path"` — pick a value from the response object;
- `{"list": "dot.path", "pick": {...}}` — pick fields from each array element;
- Only projected fields reach the model. Missing fields are errors (fail
  closed); undeclared fields are dropped. Non-2xx responses never echo raw
  bodies.

### Settlement (side-effecting tools)

| Step | State |
|---|---|
| Before sending | `sending` (for `read`: `running`) |
| Success | `sent` / `completed` + stored result |
| Definitive rejection (4xx) | `failed` (+ error) |
| Unknown (timeout, connection loss, 5xx on send) | stays `sending` |

Recovery re-enters the same executor (the existing `recovery::settle_tools`
path); rulings:

| Ledger state | Ruling |
|---|---|
| `sent` / `completed` + result | Reuse the stored result; never resend. |
| `sending` | Answer with `execution_outcome: "unknown"`: the call may or may not have executed; verify before retrying. |
| `failed` (send) | Answer the stored failure; never resend. |
| `failed` / `running` (read) | Re-execute (no side effect). |

The unique `(thread_id, input_record_id, responses_call_id)` index makes
replays exact: a replayed call returns the settled result without a second
request. `append_tool_output_item` reuses and backfills the ledger's
`output_record_id`, mirroring `worker_calls`.

### Errors the model sees

- `400`s are not special-cased: service rejections read as
  `"<tool> was rejected (HTTP nnn)"`; argument/schema problems answer with the
  validation message so the model can self-correct.
- `read` calls retry once on 5xx/network before answering
  `"<tool> is temporarily unavailable (...)"`.
- `send` calls that cannot be resolved answer with
  `{"error": "... unknown outcome ...", "execution_outcome": "unknown"}`.
- Transport error strings are never surfaced (they can embed request URLs).

## Security requirements (MUST)

- Credentials only in the user database and Controller memory — never in tool
  schemas, tool results, history, logs, API responses or Worker devices.
- No arbitrary HTTP: every reachable request is a declared binding; methods,
  paths and parameter slots are validated at load time.
- Projection deny-by-default; error messages stay sanitized.
- `send` tools must declare a settlement strategy.
- Every connector ships with mock-backed tests covering read, send, failure
  mapping and replay (see `src/cloud/custom_tools.rs` tests and the Linkit
  fixture).

## Adding a connector

1. Add a `custom_tools.<id>` block to `tools.json` (copy the shape from the
   Linkit entry).
2. Run `cargo test custom_tools` — the catalog validation test enforces the
   prefix, uniqueness, binding completeness, projections, settlement and
   limits.
3. Extend the module tests with a mock for the new connector's critical paths
   (read, send, 4xx, unknown outcome). Tests are part of the change.
4. Provision credentials: reference existing managed fields, or plan the
   `custom_tool_settings` key (the HTTP surface for self-serve keys is
   deliberately not built yet; see “Deferred”).
5. Ship with the next release. Beyond data and tests, no dispatcher, request
   builder, database or web changes are required.

## Current connectors

**Linkit** (`linkit`) — credentials are managed by the existing Linkit
connection flow (`integration_settings`), and the tools appear automatically
for connected users:

- `linkit_list_conversations`, `linkit_read_messages` — `read`;
- `linkit_send_message` — `send` (`mark_then_send`; no provider idempotency
  key exists, so unknown outcomes are reported conservatively);
- `linkit_open_direct` — modelled as `send` (conservative) until the endpoint
  is confirmed get-or-create.

## Deferred (by design)

- Self-serve credential editing: `GET/PUT /api/custom-tools/{id}` plus a
  generic Integrations card — land with the first connector that stores keys
  in `custom_tool_settings`.
- OAuth/token refresh, multi-step choreography, binary/file payloads:
  review-gated exceptions.
- Runtime hot-loading of declarations and tool gating (`defer_loading`-style):
  revisit when the catalog grows.

## Code map

- `tools.json` — `custom_tools` declarations (single source; also rendered by
  the Tools page).
- `src/cloud.rs` — `custom_tools::enabled_for` in the request-assembly chain;
  the dispatcher branch in `start_response_tool`; ledger reuse/backfill in
  `append_tool_output_item`.
- `src/cloud/custom_tools.rs` — declaration model, validation-by-test,
  executor, projection, settlement, rate limiting, mock-backed tests.
- User schema v31 — `custom_tool_calls` (settlement/audit ledger) and
  `custom_tool_settings` (self-serve credentials).
- `web/src/main.tsx` — Tools page renders the Custom Tools group from the
  catalog; labels come from the catalog, so tools never need web edits.
