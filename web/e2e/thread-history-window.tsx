import { StrictMode, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import { ThreadHistory } from "../src/components/thread-history"
import { Button } from "../src/components/ui/button"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerProvider, MessageScrollerViewport } from "../src/components/ui/message-scroller"
import { historyPayloadText } from "../src/lib/history-payload"
import type { HistoryRecord } from "../src/lib/thread-history"
import "../src/styles.css"

const base = 1_800_000_000
function record(id: number, kind: HistoryRecord["kind"], payload: unknown, seconds: number): HistoryRecord {
  return { id, kind, payload, thread_id: "thread-a", created_at: base + seconds }
}

const turnCount = 20
const recordsPerTurn = 4
const pageSize = recordsPerTurn * 4
const all: HistoryRecord[] = []
for (let turn = 1; turn <= turnCount; turn += 1) {
  const id = turn * 10
  const start = (turn - 1) * 60
  all.push(record(id, "input", { content: `第 ${turn} 轮用户输入：先看一下部署状态，然后继续跑测试。` }, start))
  all.push(record(id + 1, "response_output", { id: `rs_${turn}`, type: "reasoning", summary: [{ text: `第 ${turn} 轮推理摘要：检查环境、读取日志、准备执行。` }] }, start + 5))
  all.push(record(id + 2, "tool_output", { output: `第 ${turn} 轮工具输出：服务运行正常，日志没有异常。` }, start + 10))
  all.push(record(id + 3, "response_output", { id: `msg_${turn}`, type: "message", content: [{ text: `第 ${turn} 轮回复：部署检查通过。接下来我会继续验证依赖、运行端到端测试，并把结果整理成报告。` }] }, start + 15))
}

function Fixture() {
  const [startIndex, setStartIndex] = useState(all.length - recordsPerTurn * 10)
  const records = useMemo(() => all.slice(startIndex), [startIndex])
  const loadEarlier = () => setStartIndex((index) => Math.max(0, index - pageSize))
  const hasOlder = startIndex > 0
  return <main className="flex h-svh min-w-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-3 border-b p-3 text-sm"><h1 className="font-semibold">Cybion · Thread history window</h1></header>
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        {hasOlder && <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-6">
          <Button className="pointer-events-auto shadow-sm" type="button" size="sm" variant="outline" onClick={loadEarlier}>Load earlier</Button>
        </div>}
        <MessageScrollerViewport>
          <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
            <ThreadHistory records={records} language="zh" renderRecord={(item) => <article data-record-id={item.id} className="min-w-0 rounded-lg border bg-card p-3 text-sm">
              <p className="whitespace-pre-wrap break-words">{historyPayloadText(item.payload)}</p>
            </article>} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton behavior="auto" />
      </MessageScroller>
    </MessageScrollerProvider>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
