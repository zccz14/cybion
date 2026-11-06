import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import { ThreadNotes } from "../src/components/thread-notes"
import { ThreadManualLoads } from "../src/components/thread-manual-loads"
import "../src/styles.css"

// The Thread view stacks the notes row directly above the loaded manuals, so the
// fixture shows both to keep that stacking honest.
const notes = [
  { id: "a1b2c3d4", text: "修好 CI 的 flaky 测试" },
  { id: "9f8e7d6c", text: "把 PR #2 的恢复演练补上" },
  { id: "1122aabb", text: "确认生产库的 WAL 增长是否还在阈值内，并把结论写进值班记录里" },
]

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [count, setCount] = useState(notes.length)
  return <main className="flex min-h-screen flex-col justify-end bg-background p-4 text-foreground">
    <header className="mb-4 flex flex-wrap items-center gap-3 border-b pb-3 text-sm">
      <h1 className="mr-auto font-semibold">Cybion · Thread notes</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <button onClick={() => setCount(count === 3 ? 1 : count === 1 ? 0 : 3)}>Count</button>
    </header>
    <section className="mx-auto w-full max-w-4xl">
      <div data-testid="notes"><ThreadNotes notes={notes.slice(0, count)} language={language} /></div>
      <div className="mt-3 border-t pt-3" data-testid="manuals">
        <ThreadManualLoads view={{ head: 12, tail: 14, loaded: [], limit: 3 }} lookup={new Map()} language={language} />
      </div>
    </section>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><HashRouter><Fixture /></HashRouter></StrictMode>)
