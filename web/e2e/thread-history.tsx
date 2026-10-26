import { StrictMode, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { AssistantMessage } from "../src/components/assistant-message"
import { ThreadHistory } from "../src/components/thread-history"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/components/ui/message-scroller"
import { historyPayloadText } from "../src/lib/history-payload"
import type { HistoryRecord } from "../src/lib/thread-history"
import { formattedTime } from "../src/lib/time"
import { pendingResponseRecords, type ThreadResponseView } from "../src/lib/thread-response"
import "../src/styles.css"

// 11 列的宽表格，且单元格里是不可断行的 id 与哈希：对话栏放不下，
// 只能靠表格自己的横向滚动看全。
const wideTable = `| Worker | worker_id | 归属 | 状态 | 系统 | 架构 | 内存 | 磁盘 | 版本 | 最后在线 | 安装包 sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MacMini | 4d38279c24cc494dbd3130b46030b3957a1c | 031a393d8a0a4ca08cb1313e0d71dfa9 | online | macOS 26.1 | arm64 | 19MB | 3.4GB | 0.6.13 | 20260219T084107Z | 9f2c1d8a7b6e5f4c3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f |
| Linux US | 63502b089c2247eeb136e358184f3c92440b | 3e8708acaf4d4162aa6034d63c9e5d5b | offline | Ubuntu 24.04 | x86_64 | 12MB | 811MB | 0.6.12 | 20260218T231055Z | 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809 |`

const base = Math.floor(Date.now() / 1000) - 4_000
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
  record(7, "response_output", { id: "msg_7", type: "message", content: [{ text: `AI 回复：部署检查通过，正在检查服务。\n\n${wideTable}` }] }, 3690),
]
const liveItem = { id: "rs_live", type: "reasoning", summary: [{ text: "正在检查服务健康状态。" }] }
const responseView: ThreadResponseView = {
  audit_id: 10, input_record_id: 1, started_at: base + 4000, status: "in_flight",
  response: {
    completed: false, output: [{ item: liveItem, done: false, record_id: null }], safety_buffering: null,
  },
}

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [threadId, setThreadId] = useState("thread-a")
  const [history, setHistory] = useState(historyRecords)
  const [view, setView] = useState(responseView)
  const [minimal, setMinimal] = useState(false)
  const [running, setRunning] = useState(false)
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
      <button aria-pressed={minimal} onClick={() => setMinimal(!minimal)}>Minimal</button>
      <button aria-pressed={running} onClick={() => setRunning(!running)}>Running</button>
    </header>
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            <ThreadHistory records={records} language={language} minimal={minimal} running={running} renderRecord={(item) => isMessageRecord(item) ? <article data-record-id={item.id} className="min-w-0"><AssistantMessage language={language} text={historyPayloadText(item.payload)} time={formattedTime(language, item.created_at)} /></article> : <article data-record-id={item.id} className="min-w-0 rounded-lg border bg-card p-3 text-sm">
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
// 和对话页一样，模型回复走 AssistantMessage 的 Markdown 渲染。
function isMessageRecord(item: HistoryRecord) {
  const payload = item.payload
  return item.kind === "response_output" && typeof payload === "object" && payload !== null && (payload as { type?: string }).type === "message"
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
