import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createTestServer } from "./vite-server.ts"

const png = `iVBORw0KGgo${"A".repeat(64)}`
const generated = { id: 11, thread_id: "thread-a", kind: "tool_output", payload: { type: "image_generation_call", result: `${png}B`, output_format: "png" }, created_at: 1 }
const screenshot = { id: 12, thread_id: "thread-a", kind: "tool_output", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ data: `${png}C` }) }, created_at: 2, screenshot: true }

test("image groups render each record's image in a one-row carousel with a zoom dialog trigger in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { ThreadImageGroup } = await server.ssrLoadModule("/src/components/thread-image-group.tsx")
    for (const language of ["zh", "en"]) {
      const html = renderToStaticMarkup(createElement(ThreadImageGroup, { language, images: [generated, screenshot] }))
      assert.match(html, /^<div data-slot="thread-image-group"/)
      assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 2)
      assert.ok(html.indexOf(`${png}B`) < html.indexOf(`${png}C`), "images keep record order")
      const labels = language === "zh" ? ["生成的图片", "屏幕截图", "查看图片"] : ["Generated image", "Screenshot", "Open image"]
      for (const label of labels) assert.ok(html.includes(`alt="${label}"`) || html.includes(`aria-label="${label}"`), `missing ${label} in ${language}`)
      assert.equal((html.match(/aria-label="(?:查看图片|Open image)"/g) ?? []).length, 2)
      assert.ok(html.includes('data-slot="carousel"') && html.includes('data-slot="carousel-content"'))
      assert.equal((html.match(/data-slot="carousel-item"/g) ?? []).length, 2)
      assert.ok(html.includes('data-slot="carousel-previous"') && html.includes('data-slot="carousel-next"'))
      assert.ok(html.includes("Previous slide") && html.includes("Next slide"))
    }
    const single = renderToStaticMarkup(createElement(ThreadImageGroup, { language: "en", images: [generated] }))
    assert.ok(single.includes("Generated image"))
    assert.ok(!single.includes("Screenshot"))
    assert.ok(single.includes('data-slot="carousel-item"'))
    assert.ok(!single.includes("carousel-previous") && !single.includes("Next slide"), "a single image renders without navigation controls")
  } finally {
    await server.close()
  }
})

test("ThreadHistory keeps images outside collapsed groups and shows the minimal group with the tail", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { ThreadHistory } = await server.ssrLoadModule("/src/components/thread-history.tsx")
    const { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } = await server.ssrLoadModule("/src/components/ui/message-scroller.tsx")
    const render = (node: unknown) => renderToStaticMarkup(createElement(MessageScrollerProvider, { defaultScrollPosition: "end" }, createElement(MessageScroller, null, createElement(MessageScrollerViewport, null, createElement(MessageScrollerContent, null, node)))))
    const stub = (record: { id: number; payload: unknown }) => createElement("div", { "data-record-id": record.id }, "record")
    const records = [
      { id: 1, thread_id: "thread-a", kind: "input", payload: { content: "start" }, created_at: 1 },
      { id: 2, thread_id: "thread-a", kind: "response_output", payload: { id: "rs_2", type: "reasoning" }, created_at: 2 },
      generated,
      screenshot,
      { id: 13, thread_id: "thread-a", kind: "response_output", payload: { id: "msg_13", type: "message" }, created_at: 5 },
    ]
    const normal = render(createElement(ThreadHistory, { records, language: "en", minimal: false, renderRecord: stub }))
    assert.ok(!normal.includes('data-slot="thread-image-group"'), "normal mode keeps images as standalone items")
    for (const id of [11, 12]) {
      const before = normal.slice(0, normal.indexOf(`data-record-id="${id}"`))
      assert.equal((before.match(/<details/g) ?? []).length, (before.match(/<\/details>/g) ?? []).length, `record ${id} must not sit inside a collapsed group`)
    }
    const minimal = render(createElement(ThreadHistory, { records, language: "en", minimal: true, renderRecord: stub }))
    assert.equal((minimal.match(/data-slot="thread-image-group"/g) ?? []).length, 1)
    assert.equal((minimal.match(/data:image\/png;base64,/g) ?? []).length, 2)
    assert.equal((minimal.match(/data-slot="carousel-item"/g) ?? []).length, 2)
    assert.ok(minimal.includes("Next slide"), "multiple images get navigation controls")
    assert.ok(minimal.indexOf('data-record-id="13"') < minimal.indexOf('data-slot="thread-image-group"'), "the image group renders with the tail candidate")
    assert.ok(!minimal.includes('data-record-id="11"') && !minimal.includes('data-record-id="12"'), "grouped images are not duplicated through renderRecord")
  } finally {
    await server.close()
  }
})

test("the app thread view renders generated images inline", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(source, /const imageSource = generatedImageSource\(record\.payload\)/)
  assert.match(source, /<img src=\{imageSource\} alt=\{t\("generatedImage"\)\}/)
})
