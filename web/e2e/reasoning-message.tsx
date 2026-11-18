import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import { HistoryMessage, type HistoryRecord } from "@zccz14/cybion-components"
import "../src/styles.css"

const base = 1_800_000_000
const record = (id: number, payload: unknown, seconds: number): HistoryRecord => ({
  id, thread_id: "thread-a", kind: "response_output", payload, created_at: base + seconds,
})

// 三种上游写法并列：有 summary、只有 reasoning_text 内容、两者都没有。
const records = [
  record(1, { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "正在分析部署记录，先看最近一次构建。" }], content: [{ type: "reasoning_text", text: "原始推理文本：不应该出现在卡片里。" }] }, 0),
  record(2, {
    id: "rs_2", type: "reasoning", summary: [], status: "completed",
    content: [{ type: "reasoning_text", text: "Clippy passed. Now run cargo test. This will rebuild test binaries (target reused). Let me run the full test suite." }],
  }, 12),
  record(3, { id: "rs_3", type: "reasoning", summary: [], status: "completed" }, 24),
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex min-h-svh flex-col gap-4 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div className="flex w-full max-w-3xl flex-col gap-4">
      {records.map((item) => <HistoryMessage key={item.id} language={language} record={item} inFlight={false} />)}
    </div>
  </main>
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
