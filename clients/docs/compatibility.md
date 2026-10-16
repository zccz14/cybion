# Compatibility

The shells exist because the Cybion session check uses Ed25519 through the Web
Crypto API, and not every engine that renders the app has it. This page is the
support matrix, the shim, and the cases where you don't need a shell at all.

## Ed25519 in `crypto.subtle`

Web Crypto gained Ed25519 at different times per engine:

| Engine | First version with Ed25519 |
| --- | --- |
| Chrome / Chromium (incl. Android WebView) | 137 (May 2025) |
| Firefox | 129 |
| Apple WebKit (Safari, `WKWebView`) | Safari 17 (macOS 14, iOS 17) |

Anything older throws on
`crypto.subtle.importKey("jwk", {kty:"OKP",crv:"Ed25519",…}, …)` with
`NotSupportedError: … Algorithm: Unrecognized name`, and the Cybion session
check reports *"Your browser is too old to complete the session security
check"*.

Consequences for the shells:

- **macOS 12–13** ship a WebKit without Ed25519, so the macOS shell injects the
  shim. On macOS 14+ the same shim detects native support and steps aside.
- **Android** WebView is updatable, so most devices pass without the shim; the
  shim covers devices whose WebView has not reached Chromium 137 (the Huawei
  target was Chromium 114). The shim is harmless once the WebView catches up.

## The shim

[`shell/ed25519-polyfill.js`](../shell/ed25519-polyfill.js) makes Ed25519
available in `crypto.subtle` using
[TweetNaCl](https://tweetnacl.js.org/) (public domain), as a fallback only. It
wraps `crypto.subtle.importKey` and `crypto.subtle.verify` and **prefers the
platform implementation**: on an engine that already has Ed25519 it delegates
straight through, and it falls back to TweetNaCl only when the native import
rejects (the first failed import is remembered for the rest of the document).
It is injected before any page script: as a document-start script on Android
(`WebViewCompat.addDocumentStartJavaScript`) and as a `WKUserScript` at
`documentStart` on macOS.

Scope:

- **Public keys, verify only.** It adds `importKey` for Ed25519 JWK / SPKI / raw
  public keys and `verify`. It does **not** implement `sign`, `exportKey`, or
  `generateKey`; importing a private-key JWK, or requesting `sign`, is rejected
  rather than silently mishandled. This is exactly the surface the session check
  needs — it only imports a public key
  (`{kty:"OKP",crv:"Ed25519",x}`) and verifies.
- **Native first.** On engines with Ed25519 the wrappers are pass-throughs and
  TweetNaCl never runs.
- **Auditable.** It is the only privileged code in either shell. Read it.

This is a transitional measure. As WebView and WebKit updates land, the shim
stops being exercised; it can be removed once the shells' minimum supported
engines gain native Ed25519.

## Platform support

| | Minimum | Notes |
| --- | --- | --- |
| Android | API 24 (Android 7) | Requires an updatable WebView. The shim is injected via `DOCUMENT_START_SCRIPT` (androidx.webkit); a WebView too old for that API is also too old to have native Ed25519. |
| macOS | 12 (Monterey) | Universal binary (arm64 + x86_64). |

## When you don't need a shell

- **Desktop browsers** already run the web app — just use `cybion.ntnl.io`.
- **Modern iOS/iPadOS** (17+) Safari supports Ed25519, so iPad users can open
  the site directly and *Add to Home Screen*; no native shell is required.
- A shell is only worth installing where the platform's WebView is the
  bottleneck or the user wants an app icon and a real window.

## Distribution notes

- **macOS Gatekeeper.** The DMG is signed ad-hoc. On first launch Gatekeeper
  may say *"Cybion can't be opened because Apple cannot check it for malicious
  software"*; open **System Settings → Privacy & Security** and choose **Open
  Anyway**, or right-click the app → **Open**. A Developer ID signature +
  notarization would remove this prompt.
- **Android sideloading** requires *Install unknown apps* for the browser or
  file manager used to open the APK.
