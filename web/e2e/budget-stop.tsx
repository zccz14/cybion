import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { HistoryMessage, type HistoryRecord } from "@zccz14/cybion-components"
import "../src/styles.css"

// The record the kernel leaves when a Thread hits its USD limit, exactly as
// `stop_for_budget` writes it: the prose is for the model, the two amounts are
// what the panel restates in the reader's language.
function budgetRecord(id: number, spent: number, budget: number): HistoryRecord {
  return {
    id, thread_id: "thread-a", kind: "activity", created_at: 1_760_000_000,
    payload: {
      role: "system",
      content: `Budget exhausted: $0.54 settled of the $0.01 limit. Raise the limit in Thread settings, then send a message to continue.`,
      budget_usd_nanos: budget,
      spent_usd_nanos: spent,
    },
  }
}

const stopped = budgetRecord(610468, 540_000_000, 10_000_000)
// An ordinary activity record, to prove the panel did not swallow the generic card.
const ordinary: HistoryRecord = {
  id: 610469, thread_id: "thread-a", kind: "activity", created_at: 1_760_000_100,
  payload: { content: "Activity：已完成第一阶段检查。" },
}

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [raised, setRaised] = useState<string>("none")
  return <main className="flex flex-col gap-6 p-5">
    <header className="flex flex-wrap items-center gap-3">
      <h1 className="mr-auto text-sm font-semibold">Cybion · budget stop</h1>
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
      <span data-testid="raised">{raised}</span>
    </header>
    <div id="actionable">
      <HistoryMessage
        language={language}
        record={stopped}
        inFlight={false}
        onRaiseBudget={(addedUsdNanos) => setRaised(String(addedUsdNanos))}
      />
    </div>
    {/* A host that cannot act (a shared, read-only Thread) gets the same record
        without a control that would do nothing. */}
    <div id="read-only">
      <HistoryMessage language={language} record={stopped} inFlight={false} />
    </div>
    <div id="ordinary">
      <HistoryMessage language={language} record={ordinary} inFlight={false} />
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
