import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { Markdown } from "../src/components/markdown"
import "../src/styles.css"

const flowchart = "```mermaid\ngraph TD\n  A[用户输入] --> B{意图识别}\n  B -->|代码任务| C[调用 Worker]\n  B -->|聊天| D[直接回复]\n```"
const partial = "```mermaid\ngraph TD\n  A -->\n```"
const snippet = "```ts\nconst answer = 42\n```"

function Message({ slot, children }: { slot: string; children: ReactNode }) {
  return <article data-message={slot} className="prose prose-sm max-w-[75ch] dark:prose-neutral dark:prose-invert prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">{children}</article>
}

function Fixture() {
  const [completed, setCompleted] = useState(false)
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get("theme") === "dark")
  useEffect(() => { document.documentElement.classList.toggle("dark", dark) }, [dark])
  return <main className="flex min-h-svh flex-col gap-6 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setDark(!dark)}>Theme</button>
      <button onClick={() => setCompleted(!completed)}>Complete</button>
    </header>
    <Message slot="chart"><Markdown>{flowchart}</Markdown></Message>
    <Message slot="stream"><Markdown>{completed ? flowchart : partial}</Markdown></Message>
    <Message slot="snippet"><Markdown>{snippet}</Markdown></Message>
  </main>
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
