import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { CheckpointMessage } from "../src/components/checkpoint-message"
import type { HistoryRecord } from "../src/lib/thread-history"
import "../src/styles.css"

const base = 1_800_000_000
const checkpoint = `# Durable working context

## 概念与术语

- **Thread**：独立的对话与执行单元。
- **Checkpoint**：把上下文压缩成 Markdown 的持久记录。

## 权威资源与精确位置

- 用户数据库：\`~/.cybion/users/<uid>.sqlite3\`
- 参考资料：[Thread model](https://example.com/docs/threads)

## 当前目标与下一步

继续验证 checkpoint 的渲染效果，然后检查暗色主题。

## 未完成的工作与证据路径

\`\`\`json
[{"topic_key":"checkpoint-rendering","status":"open","search_keywords":["markdown","checkpoint"]}]
\`\`\`
`

function record(id: number, content: string, seconds: number): HistoryRecord {
  return { id, thread_id: "thread-a", kind: "checkpoint", payload: { role: "developer", content }, created_at: base + seconds }
}

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex min-h-svh flex-col gap-4 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <CheckpointMessage language={language} record={record(6, checkpoint, 3681)} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
