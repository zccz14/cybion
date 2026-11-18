import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// The Markdown renderer pulls KaTeX's stylesheet, which jsdom cannot load; the
// card's own text choice is what this test is about, so the renderer stands in
// as plain text.
vi.mock("@zccz14/ux", () => ({ Markdown: ({ content }: { content: string }) => content }))

import { HistoryMessage } from "../src/components/history-message"
import type { HistoryRecord } from "../src/lib/thread-history"

const reasoning = (payload: unknown): HistoryRecord => ({ id: 7, thread_id: "thread-a", kind: "response_output", payload, created_at: 7 })

// The card also ships the raw payload behind its expander, which repeats every
// string in the item, so the assertions read the card with that panel dropped.
const cardText = (payload: unknown) => {
  const { container, unmount } = render(<HistoryMessage language="en" record={reasoning(payload)} inFlight={false} />)
  const card = container.querySelector('[data-slot="reasoning-message"]')
  expect(card).not.toBeNull()
  const visible = card!.cloneNode(true) as HTMLElement
  visible.querySelector("details")?.remove()
  const text = (visible.textContent ?? "").trim()
  unmount()
  return text
}

describe("reasoning card", () => {
  it("shows the summary the upstream wrote when the item has one", () => {
    const text = cardText({ type: "reasoning", summary: [{ type: "summary_text", text: "Checked the tests." }], content: [{ type: "reasoning_text", text: "raw thinking" }] })
    expect(text).toContain("Checked the tests.")
    expect(text).not.toContain("raw thinking")
  })

  it("shows the content when the summary is empty", () => {
    const text = cardText({
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "Clippy passed. Now run cargo test. This will rebuild test binaries (target reused). Let me run the full test suite." }],
    })
    expect(text).toContain("Clippy passed. Now run cargo test.")
    expect(text).toContain("Let me run the full test suite.")
  })

  it("keeps every content part when the summary is missing altogether", () => {
    const text = cardText({ type: "reasoning", content: [{ type: "reasoning_text", text: "first" }, { type: "reasoning_text", text: "second" }] })
    expect(text).toContain("first")
    expect(text).toContain("second")
  })

  it("ignores a summary that is only whitespace and falls through to the content", () => {
    const text = cardText({ type: "reasoning", summary: [{ type: "summary_text", text: "   " }], content: [{ type: "reasoning_text", text: "content wins" }] })
    expect(text).toContain("content wins")
  })

  it("keeps the placeholder when the item carries no text at all", () => {
    expect(cardText({ type: "reasoning", summary: [] })).toContain("—")
  })
})
