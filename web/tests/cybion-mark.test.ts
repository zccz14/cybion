import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const triangle = "M32 13.8 L53 50.2 L11 50.2 Z"

test("the Cybion mark renders the shared triangle in the current text color", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { CybionMark } = await server.ssrLoadModule("/src/components/cybion-mark.tsx")
    const html = renderToStaticMarkup(createElement(CybionMark, { className: "size-6 shrink-0" }))
    assert.ok(html.includes('viewBox="0 0 64 64"'))
    assert.ok(html.includes(triangle))
    assert.ok(html.includes('stroke="currentColor"'))
    assert.ok(html.includes('aria-hidden="true"'))
  } finally {
    await server.close()
  }
})

test("the favicon keeps that triangle and follows the browser color scheme", () => {
  const svg = readFileSync(new URL("../public/cybion-mark.svg", import.meta.url), "utf8")
  assert.ok(svg.includes(triangle))
  assert.match(svg, /path \{ stroke: #000; \}/)
  assert.match(svg, /@media \(prefers-color-scheme: dark\) \{\s*path \{ stroke: #fff; \}/)
})

test("the sidebar logo inherits the app theme instead of inverting the favicon", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(main, /<CybionMark className="size-6 shrink-0" \/>/)
  assert.ok(!main.includes("dark:invert"))
})
