import { createServer, type InlineConfig, type ViteDevServer } from "vite"

// INVARIANT: unit tests must not write the dependency optimizer cache that
// `vite dev` serves e2e pages from. Vite keys that cache by config hash, so a
// cache written here looks valid to the dev server and makes it skip
// pre-bundling; it then optimizes client dependencies while e2e pages are open
// and forces full page reloads in the middle of a test.
export function createTestServer(options: InlineConfig): Promise<ViteDevServer> {
  return createServer({ ...options, cacheDir: "node_modules/.vite-tests" })
}
