import { describe, expect, it } from "vitest"

import { historyPayloadText, reasoningPayloadText } from "../src/lib/history-payload"

const summary = (text: string) => ({ type: "reasoning", summary: [{ type: "summary_text", text }] })
const reasoning = (text: string) => ({ type: "reasoning_text", text })

describe("reasoning payload text", () => {
  it("prefers the summary the upstream wrote", () => {
    const payload = { type: "reasoning", summary: [{ type: "summary_text", text: "Checked the tests." }], content: [reasoning("raw thinking")] }
    expect(reasoningPayloadText(payload)).toBe("Checked the tests.")
    expect(historyPayloadText(payload)).toBe("Checked the tests.")
  })

  it("falls back to the reasoning content when the summary is empty", () => {
    const payload = { type: "reasoning", summary: [], content: [reasoning("Clippy passed. Now run cargo test.")] }
    expect(reasoningPayloadText(payload)).toBe("Clippy passed. Now run cargo test.")
    expect(historyPayloadText(payload)).toBe("Clippy passed. Now run cargo test.")
  })

  it("joins several content parts as paragraphs", () => {
    expect(reasoningPayloadText({ type: "reasoning", content: [reasoning("first"), reasoning("second")] })).toBe("first\n\nsecond")
  })

  it("treats a whitespace-only summary as empty", () => {
    expect(reasoningPayloadText({ type: "reasoning", summary: [{ type: "summary_text", text: "   " }], content: [reasoning("content wins")] })).toBe("content wins")
    expect(reasoningPayloadText(summary("   "))).toBe("")
  })

  it("answers empty for an item with no text and for anything that is not reasoning", () => {
    expect(reasoningPayloadText({ type: "reasoning", summary: [] })).toBe("")
    expect(reasoningPayloadText({ type: "message", content: [reasoning("not reasoning")] })).toBe("")
    expect(reasoningPayloadText(null)).toBe("")
  })
})
