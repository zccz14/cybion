# Thread identity

An integrating service that creates a Thread knows its id. What it could not
prove was that a request came from *that* Thread: the usual answer was to mint a
secret and paste it into the Thread's first message, which puts a long-lived
credential in a transcript that is archived, shared, exported, and replayed into
every later request.

`create_thread_token` replaces the secret with an assertion. The Thread asks
Cybion to sign a short-lived JWT whose subject is the Thread itself, and the
service verifies the signature against a public key. Nothing secret is stored
anywhere: the service already recorded the Thread id, and `sub` is the whole of
the answer it needs.

## The token

```json
{
  "iss": "https://cybion.ntnl.io",
  "sub": "5b2e4f9a-6c3d-4a1e-9f00-1d2c3b4a5e6f",
  "iat": 1780000000,
  "exp": 1780000900
}
```

`sub` is always the Thread that called the tool — it is not an argument, so a
model cannot name another Thread. `exp` is fifteen minutes after `iat`.

The header names the signing key:

```json
{"alg":"EdDSA","kid":"9f2a6c1b8e4d7053","typ":"JWT"}
```

## What it proves, and what it does not

It proves **which Thread is calling**. It does not say what that Thread may do,
and it says nothing about the human whose account owns the Thread.

Two rules follow, and both are the verifier's:

1. **Authorize from your own record, never from the token.** The Thread id in
   `sub` must be one *you* created — the id you stored when you called
   `POST /v1/threads`, or the `external_ref` you gave it. A token proves identity
   only because you already know what that identity is attached to.
2. **Check the audience you expect by construction, not by claim.** This token
   carries no `aud`: it is an identity, not a capability. Any service trusting
   the key will accept any Thread's token, so never treat "the signature is
   valid" as "this request is for us" — the mapping in rule 1 is what bounds it.

## Verifying

The public key is one Ed25519 key, published at
`https://cybion.ntnl.io/.well-known/jwks.json`:

```json
{"keys":[{
  "kid":"9f2a6c1b8e4d7053",
  "kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig",
  "x":"<base64url of the 32-byte public key>"
}]}
```

Four steps, in this order:

1. Decode the header, take `kid`, and select that key from the JWKS. Fetch the
   document lazily and cache it; refresh on an unknown `kid`, and keep serving
   the cached copy if Cybion is unreachable — a JWKS outage must not 401 every
   request.
2. Verify the Ed25519 signature over the `header.payload` signing input. Reject
   `alg` other than `EdDSA` (no `none`, no algorithm chosen by the caller).
3. Check `iss` equals `https://cybion.ntnl.io` exactly, and `exp` is in the
   future.
4. Take `sub` as the Thread id and look it up in your own tables.

With `jose` (TypeScript, including Cloudflare Workers):

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwks = createRemoteJWKSet(
  new URL('https://cybion.ntnl.io/.well-known/jwks.json'),
);

const { payload } = await jwtVerify(token, jwks, {
  issuer: 'https://cybion.ntnl.io',
  algorithms: ['EdDSA'],
});
const threadId = payload.sub; // then: is this a Thread I created?
```

In Rust, the shape is the same one `auth-mini-axum` uses for Auth Mini, but that
crate is not reusable here: it expects Auth Mini's `sid` and `typ` claims, and a
Thread has no session. Verify directly with `ed25519-dalek` — decode the three
segments, rebuild `header.payload`, and check the signature against the `x` of
the key whose `kid` the header names.

## Retiring an injected secret

A service moving off a pasted token keeps its old path until existing Threads
finish, then deletes it:

- mint nothing on the Thread's behalf, and put nothing in the first message;
- let the Thread call `create_thread_token` when it needs to call you;
- map `sub` to the object whose Thread it is, which is the row the service
  already had;
- drop the stored secret and its column once no live Thread depends on it.

The Thread's history still shows the issued tokens, so keep them short-lived:
the point of the change is that a token found in an archive months later is
worthless, not that the archive is clean.
