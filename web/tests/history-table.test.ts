import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createServer } from "vite"

test("history table renders database fields and server pagination without transforming protocol payloads", async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: "custom" })
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  try {
    const { HistoryTable } = await server.ssrLoadModule("/src/components/history-table.tsx")
    client.setQueryData(["history-table", "page=2"], {
      items: [{ id: 580, thread_id: "thread-raw-id", request_input_id: null, role: "assistant", content: "", kind: "response_output", payload: "not JSON: persisted text", visible: 0, created_at: 1789373448, content_truncated: false, payload_truncated: true }],
      total: 21, page: 2, page_size: 20, sort: "id", direction: "desc",
    })
    for (const language of ["en", "zh"]) {
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ["/history?page=2"] },
          createElement(HistoryTable, { language, request: () => { throw new Error("Rows must use the page response; details load only when expanded") } }),
        ),
      ))
      assert.match(html, /aria-label="history_records"/)
      for (const column of ["id", "thread_id", "request_input_id", "role", "content", "kind", "payload", "visible", "created_at"]) {
        assert.ok(html.includes(`<span class="font-mono">${column}</span>`), column)
      }
      assert.match(html, /aria-sort="descending"/)
      assert.match(html, />580<\/code>/)
      assert.match(html, />NULL<\/code>/)
      assert.match(html, />0<\/code>/)
      assert.match(html, /not JSON: persisted text/)
      assert.match(html, /1789373448/)
      assert.match(html, /aria-expanded="false"/)
      assert.ok(html.includes(language === "en" ? "21–21 of 21 rows" : "第 21–21 条，共 21 条"))
      assert.ok(!html.includes('href="/threads/'))
    }
  } finally {
    client.clear()
    await server.close()
  }
})
