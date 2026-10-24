import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import type { ManualSummary } from "../src/components/cybion-tool-call"
import { ManualLoadNotice } from "../src/components/manual-load-notice"
import { MessageScroller, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/components/ui/message-scroller"
import { ThreadHistory } from "../src/components/thread-history"
import { ThreadManualLoads } from "../src/components/thread-manual-loads"
import { historyPayloadText } from "../src/lib/history-payload"
import { manualLoadNotice } from "../src/lib/thread-manual-loads"
import type { HistoryRecord } from "../src/lib/thread-history"
import { formattedTime } from "../src/lib/time"
import "../src/styles.css"

const manual = "8f1d2e3a-4b5c-6d7e-8f90-1a2b3c4d5e6f"
const edited = "c0ffee00-1111-2222-3333-444455556666"
const unknown = "99998888-7777-6666-5555-444433332222"
const lookup: ReadonlyMap<string, ManualSummary> = new Map([
  [manual, { name: "必读手册", description: "标准手册" }],
  [edited, { name: "LOL-MODEL", description: "模型与回测" }],
])

function record(id: number, kind: HistoryRecord["kind"], payload: unknown, created_at: number): HistoryRecord {
  return { id, thread_id: "thread-a", kind, payload, created_at }
}
// One turn that loads a Manual, works, releases another, and then replies: both
// notices are the controller's bookkeeping and belong to the process, not to the
// conversation, so the turn's own reply is all a reader sees without opening it.
const transcriptRecords = [
  record(41, "input", { role: "user", content: [{ type: "input_text", text: "按手册继续。" }] }, 1_760_000_000),
  record(42, "activity", { type: "manual_loaded", manual_id: manual }, 1_760_000_001),
  record(43, "response_output", { id: "rs_43", type: "reasoning", summary: [{ type: "summary_text", text: "先读手册。" }] }, 1_760_000_002),
  record(44, "tool_output", { type: "function_call_output", call_id: "call_44", output: "done" }, 1_760_000_003),
  record(45, "activity", { type: "manual_unloaded", manual_id: edited }, 1_760_000_004),
  record(46, "response_output", { id: "msg_46", type: "message", content: [{ type: "output_text", text: "手册已读完。" }] }, 1_760_000_005),
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-4">
    <header className="flex flex-wrap gap-2">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div id="loaded"><ThreadManualLoads view={{ head: 10, tail: 32, loaded: [manual, edited], limit: 12 }} lookup={lookup} language={language} /></div>
    <div id="unknown"><ThreadManualLoads view={{ head: 50, tail: 60, loaded: [edited, unknown], limit: 12 }} lookup={lookup} language={language} /></div>
    <div id="empty"><ThreadManualLoads view={{ head: 40, tail: 41, loaded: [], limit: 2 }} lookup={lookup} language={language} /></div>
    <div id="load-notice"><ManualLoadNotice notice={{ manual_id: manual, loaded: true }} lookup={lookup} language={language} time="10:01" recordId={43} /></div>
    <div id="unload-notice"><ManualLoadNotice notice={{ manual_id: edited, loaded: false }} lookup={lookup} language={language} time="10:02" recordId={44} /></div>
    <section id="transcript" className="h-[420px] min-h-0">
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="h-full">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-2 py-4">
              <ThreadHistory records={transcriptRecords} language={language} minimal={false} running={false} renderRecord={(item) => {
                const notice = manualLoadNotice(item)
                return notice
                  ? <ManualLoadNotice notice={notice} lookup={lookup} language={language} time={formattedTime(language, item.created_at)} recordId={item.id} />
                  : <article data-record-id={item.id} className="min-w-0 rounded-lg border bg-card p-3 text-sm">{historyPayloadText(item.payload)}</article>
              }} />
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </section>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><HashRouter><Fixture /></HashRouter></StrictMode>)
