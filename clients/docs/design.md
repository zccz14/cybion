# Design

A Cybion shell is a native window around the hosted web app. It owns no
product logic: it decides where a URL goes, keeps the session, and gets out of
the way.

## Shape

```text
        native shell                     hosted Cybion
  ┌───────────────────────────┐      ┌──────────────────────────┐
  │ WebView / WKWebView       │ ───► │ cybion.ntnl.io (SPA)     │
  │  • allowlist → in-app     │      │  auth.ntnl.io            │
  │  • everything else → OS   │      │  → talks to a Worker     │
  │  • Ed25519 shim injected  │      │    on your machine       │
  └───────────────────────────┘      └──────────────────────────┘
```

The browser tab and the shell run the *same* web app. The shell exists only so
that app can run where a normal browser can't (see
[compatibility.md](compatibility.md)).

## Decisions

- **Viewer, not Worker.** The shell never executes tasks. A paired
  [Worker](https://github.com/zccz14/cybion-worker) does. Keeping the shell
  credential-free means a lost phone exposes nothing but a signed-in browser
  session, revocable from the account.
- **One control point for navigation.** Every platform asks one function —
  *where does this URL go?* — and does one of three things: load it in the
  shell, hand it to the OS, or drop it. Android: [`UrlPolicy`](../android/app/src/main/java/io/ntnl/cybion/UrlPolicy.java);
  macOS: `NavigationPolicy` in `Sources/main.swift`.
- **One source of truth for configuration.** The start URL and the allowed
  hosts live in one file per platform
  ([`ShellConfig`](../android/app/src/main/java/io/ntnl/cybion/ShellConfig.java),
  `ShellConfig` in `Sources/main.swift`) so a real re-target is a one-line
  change and everything else follows.
- **Single window.** `window.open` / `target="_blank"` does not get a real
  popup. A new top-level URL is routed through the same navigation policy:
  allowed hosts load in the existing window, everything else goes to the OS,
  and blocked URLs are dropped. In-page modals and overlays are unaffected;
  only genuine popup windows are unsupported.
- **Persistent website data.** The shell uses the platform's default, on-disk
  website data store, so a sign-in survives restarts. The session still lives
  in the browser's cookie jar, not in shell-owned storage.
- **Recover, don't crash.** A renderer that exits (Android
  `onRenderProcessGone`, macOS `webViewWebContentProcessDidTerminate`) is
  rebuilt and the page reloaded, rather than leaving a blank window.
- **Load failures are visible.** A blocked main-frame load shows a retry
  screen instead of a dead white page.

## Layers

### Android (`android/`)

| File | Responsibility |
| --- | --- |
| `MainActivity` | Owns the `WebView`, lifecycle, file chooser, mic/camera permission prompts, network retry, renderer recovery |
| `ShellHost` | Callback interface the web clients report to |
| `CbnWebViewClient` | Main-frame errors, SSL (cancel + report), renderer-gone, URL routing |
| `CbnWebChromeClient` | Progress, file chooser, permission requests |
| `UrlPolicy` | The single `IN_APP` / `EXTERNAL` / `BLOCKED` decision |
| `ShellConfig` | `START_URL` + `ALLOWED_HOSTS` |

### macOS (`macos/`)

One Swift file (`Sources/main.swift`) with an `AppDelegate` (window + menu) and
a `NavigationPolicy`. It mirrors the Android behaviour: in-app allowlist,
external open via `NSWorkspace`, progress indicator, load-error and
renderer-crash recovery, and the same shim injected as a `WKUserScript` at
`documentStart`.

## The shared shim

[`shell/ed25519-polyfill.js`](../shell/ed25519-polyfill.js) is the one piece of
code shared by both shells. It is not copied into either tree: Android adds
`shell/` to its asset source sets, and `macos/build.sh` copies it into
`Contents/Resources`. Change it once. See
[compatibility.md](compatibility.md) for why it exists and how it deactivates.
