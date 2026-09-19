import { StrictMode, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadHistory } from "../src/components/thread-history"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/components/ui/message-scroller"
import { historyPayloadText } from "../src/lib/history-payload"
import type { HistoryRecord } from "../src/lib/thread-history"
import { pendingResponseRecords, type ThreadResponseView } from "../src/lib/thread-response"
import "../src/styles.css"

const base = 1_800_000_000
function record(id: number, kind: HistoryRecord["kind"], payload: unknown, seconds: number): HistoryRecord {
  return { id, kind, payload, thread_id: "thread-a", created_at: base + seconds }
}
const historyRecords = [
  record(1, "input", { content: "请检查部署状态。" }, 0),
  record(2, "response_output", { id: "rs_2", type: "reasoning", summary: [{ text: "正在分析部署记录。" }] }, 10),
  record(3, "response_output", { id: "fc_3", type: "function_call", name: "bash", arguments: '{"command":"git status"}' }, 30),
  record(4, "tool_output", { output: "部署检查通过。" }, 3675),
  record(5, "activity", { content: "Activity：已完成第一阶段检查。" }, 3680),
  record(6, "checkpoint", { content: "已保存上下文检查点。" }, 3681),
  record(7, "response_output", { id: "msg_7", type: "message", content: [{ text: "AI 回复：部署检查通过，正在检查服务。" }] }, 3690),
]
const liveItem = { id: "rs_live", type: "reasoning", summary: [{ text: "正在检查服务健康状态。" }] }
const responseView: ThreadResponseView = {
  audit_id: 10, input_record_id: 1, started_at: base + 4000, status: "in_flight",
  response: {
    response_id: "resp_10", completed: false, output: [{ item: liveItem, done: false, record_id: null }], server_model: null,
    model_verifications: [], safety_buffering: null, rate_limits: [], usage: null, error: null,
  },
}

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [threadId, setThreadId] = useState("thread-a")
  const [history, setHistory] = useState(historyRecords)
  const [view, setView] = useState(responseView)
  const records = useMemo(() => {
    const saved = history.map((item) => ({ ...item, thread_id: threadId }))
    return [...saved, ...pendingResponseRecords(view, saved, threadId)]
  }, [history, view, threadId])
  const append = () => {
    setHistory([...historyRecords, record(8, "response_output", liveItem, 4000), record(9, "tool_output", { output: "服务健康检查通过。" }, 4135)])
    setView({ ...view, response: { ...view.response, output: [{ item: liveItem, done: true, record_id: 8 }] } })
  }
  return <main className="flex h-svh min-w-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b p-3 text-sm">
      <h1 className="mr-auto font-semibold">Cybion · ThreadProcessGroup</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <button onClick={() => { setHistory(structuredClone(history)); setView(structuredClone(view)) }}>Poll</button>
      <button onClick={append}>Append</button>
      <button onClick={() => setHistory([...history, record(10, "response_output", { id: "msg_10", type: "message", content: [{ text: "AI 回复：全部检查通过。" }] }, 4140)])}>Finish</button>
      <button onClick={() => setThreadId(threadId === "thread-a" ? "thread-b" : "thread-a")}>Thread</button>
    </header>
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            <ThreadHistory records={records} language={language} renderRecord={(item) => <article data-record-id={item.id} className="min-w-0 rounded-lg border bg-card p-3 text-sm">
              <p className="whitespace-pre-wrap break-words">{historyPayloadText(item.payload)}</p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">原始记录 #{item.id}</summary>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.payload, null, 2)}</pre>
              </details>
            </article>} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScroller>
    </MessageScrollerProvider>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
