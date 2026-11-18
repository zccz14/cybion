import { createServer, type InlineConfig, type ViteDevServer } from "vite"

// INVARIANT: unit tests must not write the dependency optimizer cache that
// `vite dev` serves e2e pages from. Vite keys that cache by config hash, so a
// cache written here looks valid to the dev server and makes it skip
// pre-bundling; it then optimizes client dependencies while e2e pages are open
// and forces full page reloads in the middle of a test.
// A test server never serves a page, so it never needs HMR — and leaving HMR on
// is not free: vite binds its built-in websocket port (24678) for every server a
// test file creates, and `node --test` runs files concurrently, so two of them
// collide on that one port. Every test still passes and the process still exits
// 1, which is the worst way for a suite to fail. Forced here rather than at the
// call sites so no future test can reintroduce it.
export function createTestServer(options: InlineConfig): Promise<ViteDevServer> {
  return createServer({
    appType: "custom",
    ...options,
    cacheDir: "node_modules/.vite-tests",
    server: { ...options.server, middlewareMode: true, hmr: false },
  })
}
