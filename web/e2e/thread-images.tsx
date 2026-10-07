import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadHistory } from "../src/components/thread-history"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/components/ui/message-scroller"
import { historyPayloadText } from "../src/lib/history-payload"
import { threadImage, type HistoryRecord } from "../src/lib/thread-history"
import "../src/styles.css"

const base = 1_800_000_000
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6OZ0AAAAASUVORK5CYII="
function record(id: number, kind: HistoryRecord["kind"], payload: unknown, seconds: number, screenshot = false): HistoryRecord {
  return { id, thread_id: "thread-a", kind, payload, created_at: base + seconds, ...(screenshot ? { screenshot: true } : {}) }
}
export const threadImageRecords = [
  record(1, "input", { content: "先截个图。" }, 0),
  record(2, "response_output", { id: "rs_2", type: "reasoning", summary: [{ text: "准备截图。" }] }, 5),
  record(3, "tool_output", { type: "function_call_output", call_id: "call-shot", output: JSON.stringify({ data: png }) }, 40, true),
  record(4, "response_output", { id: "msg_4", type: "message", content: [{ type: "output_text", text: "截图完成。" }] }, 45),
  record(5, "input", { content: "再画一张图。" }, 100),
  record(6, "response_output", { id: "rs_6", type: "reasoning", summary: [{ text: "开始出图。" }] }, 105),
  record(7, "tool_output", { type: "function_call_output", call_id: "call-img", output: JSON.stringify({ status: "completed" }) }, 150),
  record(8, "tool_output", { type: "image_generation_call", status: "completed", result: png, output_format: "png" }, 155),
  record(9, "tool_output", { type: "function_call_output", call_id: "call-shot-2", output: JSON.stringify({ error: "screenshot failed" }) }, 160, true),
  record(10, "response_output", { id: "msg_10", type: "message", content: [{ type: "output_text", text: "图片已生成。" }] }, 165),
  record(11, "input", { content: "只出图不回复。" }, 200),
  record(12, "tool_output", { type: "image_generation_call", status: "completed", result: png, output_format: "png" }, 260),
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [minimal, setMinimal] = useState(false)
  const renderRecord = (record: HistoryRecord) => {
    const image = threadImage(record)
    if (image !== null) return <img data-record-image={record.id} src={image.source} alt={image.kind === "generated" ? "Generated" : "Screenshot"} className="block max-h-72 w-auto max-w-full rounded-lg border bg-muted" />
    return <article data-record-id={record.id} className="min-w-0 rounded-lg border bg-card p-3 text-sm">
      <p className="whitespace-pre-wrap break-words">{historyPayloadText(record.payload)}</p>
    </article>
  }
  return <main className="flex h-svh min-w-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b p-3 text-sm">
      <h1 className="mr-auto font-semibold">Cybion · Thread images</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <button aria-pressed={minimal} onClick={() => setMinimal(!minimal)}>Minimal</button>
    </header>
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            <ThreadHistory records={threadImageRecords} language={language} minimal={minimal} renderRecord={renderRecord} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScroller>
    </MessageScrollerProvider>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
