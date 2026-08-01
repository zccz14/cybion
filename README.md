# mobius

Mobius is an experimental, unrestricted AI harness for a cluster of machines. It
uses the OpenAI-compatible Responses API upstream, has no project scope or sandbox, and lets
one authenticated operator work with every reachable machine from a web console.

## Quick start

Build the embedded console and start its HTTP server:

```bash
npm --prefix web install
npm --prefix web run build
cargo run --release
```

The binary takes no arguments and reads no environment variables. It listens on
`0.0.0.0:1858` and always uses `~/.mobius/default.sqlite3`. On its first launch,
open the Web GUI, enter the Auth Mini issuer, authenticate, and enter the OpenAI
key. Mobius stores the verified Auth Mini `sub` as `app_meta.root_user_id`, then
closes the bootstrap endpoint permanently. Thereafter every API request needs that
root user's valid JWT.

Agent turns are sent to `<openai_base_url>/responses` (for example,
`https://openai.ntnl.io/v1/responses`). Mobius carries typed Responses output
items and `function_call_output` items through its local filesystem tool loop.
The Settings page stores this machine's default model ID in its local SQLite
database; the value applies to the next agent turn immediately.

For local setup, use `http://localhost:1858`. For a remote machine, put Mobius
behind an HTTPS reverse proxy before opening its GUI: Auth Mini only permits plain
HTTP redirect callbacks on exact loopback hosts.

To expose another machine, run the same no-argument binary there, complete its
one-time Web GUI initialization, then add it from the Machines page. Peers forward
the operator's JWT, so every machine independently verifies the same Auth Mini
token and root user identity.

## Security model

This is deliberately an unrestricted system: there is no sandbox, project scope,
or per-file permission model. The boundary is Auth Mini JWT verification. Every
`/api/*` request requires a valid EdDSA JWT whose issuer is the configured Auth
Mini URL, audience is the request host, and subject equals `root_user_id`.
Health checks and the embedded web assets are the only public routes.

The browser uses Auth Mini's browser SDK for persistence and refresh. The server
loads and caches Auth Mini's public JWKS for local JWT verification; it never sees
browser refresh tokens.

The embedded console includes English/Chinese UI text and persistent light/dark
theme controls; its initial theme follows the operating-system preference.

## Resources and updates

The Resources page samples CPU/load, memory, network throughput, disk space, and
SQLite main/WAL/SHM use every five seconds. It also checks GitHub Releases at
startup and every six hours. When a newer matching Linux or macOS archive is
available, Mobius downloads it, verifies the published SHA-256 checksum, and holds
it ready. Installation happens only after the root operator clicks **Restart and
update**; Mobius atomically replaces its executable and starts the new release.

## Development

```bash
npm --prefix web run check
npm --prefix web run build
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The Rust binary embeds `web/dist` using `include_bytes!`; build the web app before
Rust checks in a fresh clone. A `v*` Git tag invokes GitHub Actions to build macOS
arm64 and Linux x86_64/aarch64 release archives and publish checksums.
