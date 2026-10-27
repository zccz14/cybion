import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

test("Worker call cards show the model's intent summary", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { WorkerCallSummary } = await server.ssrLoadModule("/src/components/worker-call-summary.tsx")
    const render = (summary: string | null) => renderToStaticMarkup(createElement(WorkerCallSummary, { summary }))
    // A call recorded before the field existed has no summary to show.
    assert.equal(render(null), "")
    const html = render("检查 <script>alert(1)</script> 布局")
    assert.match(html, /<p data-slot="worker-call-summary"[^>]*>检查 &lt;script&gt;alert\(1\)&lt;\/script&gt; 布局<\/p>/)
    assert.ok(!html.includes("<script>"))
  } finally {
    await server.close()
  }
  for (const file of ["bash-command.tsx", "browser-control-call.tsx", "computer-use-call.tsx", "view-image-call.tsx"]) {
    const source = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8")
    assert.ok(source.includes("<WorkerCallSummary summary={call.summary} />"), file)
  }
})
