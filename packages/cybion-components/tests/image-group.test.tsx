import { render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"

import { ThreadHistory } from "../src/components/thread-history"
import { ThreadImageGroup } from "../src/components/thread-image-group"
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/ui/message-scroller"
import type { HistoryRecord } from "../src/lib/thread-history"

// jsdom has no media queries or observers, and embla needs both to settle a carousel.
beforeAll(() => {
  class Observer {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return [] }
  }
  window.IntersectionObserver = Observer as unknown as typeof window.IntersectionObserver
  window.ResizeObserver = Observer as unknown as typeof window.ResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

const png = `iVBORw0KGgo${"A".repeat(64)}`
const record = (id: number, kind: HistoryRecord["kind"], payload: unknown): HistoryRecord => ({ id, thread_id: "thread-a", kind, payload, created_at: id })
const generated = record(11, "tool_output", { type: "image_generation_call", result: `${png}B`, output_format: "png" })
const screenshot = { ...record(12, "tool_output", { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ data: `${png}C` }) }), screenshot: true }
const viewed = record(13, "tool_output", { type: "function_call_output", call_id: "call-3", output: [{ type: "input_image", image_url: `data:image/png;base64,${png}D` }] })

describe("thread image groups", () => {
  it("renders every image in one carousel with a zoom trigger in both languages", () => {
    for (const language of ["zh", "en"] as const) {
      const { container, unmount } = render(<ThreadImageGroup language={language} images={[generated, screenshot]} />)
      const group = container.querySelector('[data-slot="thread-image-group"]')!
      expect(group).not.toBeNull()
      expect(container.querySelectorAll("img[src^='data:image/png;base64,']")).toHaveLength(2)
      const [first, second] = [...container.querySelectorAll("img")]
      expect(first.getAttribute("src")).toContain(`${png}B`)
      expect(second.getAttribute("src")).toContain(`${png}C`)
      const labels = language === "zh" ? ["生成的图片", "屏幕截图", "查看图片"] : ["Generated image", "Screenshot", "Open image"]
      for (const label of labels) {
        expect(container.querySelectorAll(`[alt="${label}"], [aria-label="${label}"]`).length).toBeGreaterThan(0)
      }
      // Each image is its own zoom trigger.
      expect(container.querySelectorAll(`[aria-label="${labels[2]}"]`)).toHaveLength(2)
      expect(container.querySelector('[data-slot="carousel"]')).not.toBeNull()
      expect(container.querySelectorAll('[data-slot="carousel-item"]')).toHaveLength(2)
      expect(container.querySelector('[data-slot="carousel-previous"]')).not.toBeNull()
      expect(container.querySelector('[data-slot="carousel-next"]')).not.toBeNull()
      unmount()
    }
  })

  it("drops the navigation controls when a single image stands alone", () => {
    const { container } = render(<ThreadImageGroup language="en" images={[generated]} />)
    expect(container.querySelector('img[alt="Generated image"]')).not.toBeNull()
    expect(container.querySelector('img[alt="Screenshot"]')).toBeNull()
    expect(container.querySelectorAll('[data-slot="carousel-item"]')).toHaveLength(1)
    expect(container.querySelector('[data-slot="carousel-previous"]')).toBeNull()
  })

  it("labels a viewed image in both languages", () => {
    for (const language of ["zh", "en"] as const) {
      const { container, unmount } = render(<ThreadImageGroup language={language} images={[viewed]} />)
      expect(container.querySelector(`img[alt="${language === "zh" ? "查看的图片" : "Viewed image"}"]`)).not.toBeNull()
      unmount()
    }
  })
})

describe("thread history image placement", () => {
  const records = [
    record(1, "input", { content: "start" }),
    record(2, "response_output", { id: "rs_2", type: "reasoning" }),
    generated,
    screenshot,
    record(14, "response_output", { id: "msg_14", type: "message" }),
  ]
  const stub = (entry: HistoryRecord) => <div data-record-id={entry.id}>record</div>
  const wrap = (node: React.ReactNode) => render(
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller><MessageScrollerViewport><MessageScrollerContent>{node}</MessageScrollerContent></MessageScrollerViewport></MessageScroller>
    </MessageScrollerProvider>,
  )

  it("keeps images as standalone records outside collapsed groups in normal mode", () => {
    const { container } = wrap(<ThreadHistory records={records} language="en" minimal={false} renderRecord={stub} />)
    expect(container.querySelector('[data-slot="thread-image-group"]')).toBeNull()
    for (const id of [11, 12]) {
      const node = container.querySelector(`[data-record-id="${id}"]`)!
      expect(node.closest("details")).toBeNull()
    }
  })

  it("folds the turn's images into one group next to the tail in minimal mode", () => {
    const { container } = wrap(<ThreadHistory records={records} language="en" minimal running={false} renderRecord={stub} />)
    const groups = container.querySelectorAll('[data-slot="thread-image-group"]')
    expect(groups).toHaveLength(1)
    expect(within(groups[0] as HTMLElement).getAllByRole("img")).toHaveLength(2)
    expect(groups[0].querySelectorAll('[data-slot="carousel-item"]')).toHaveLength(2)
    expect(container.querySelector('[data-record-id="14"]')).not.toBeNull()
    expect(container.querySelector('[data-record-id="11"]')).toBeNull()
    expect(container.querySelector('[data-record-id="12"]')).toBeNull()
  })
})
