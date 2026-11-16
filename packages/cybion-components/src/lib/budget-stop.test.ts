import { describe, expect, it } from "vitest"
import { budgetStopNotice, newestBudgetRecordId } from "./budget-stop"
import type { HistoryRecord } from "./thread-history"

function record(id: number, payload: unknown, kind: HistoryRecord["kind"] = "activity"): HistoryRecord {
  return { id, kind, payload, thread_id: "thread-a", created_at: 1_760_000_000 }
}

const stop = (spent: number, budget: number) => ({
  role: "system",
  content: `Budget exhausted: $0.54 settled of the $0.01 limit. Raise the limit in Thread settings, then send a message to continue.`,
  budget_usd_nanos: budget,
  spent_usd_nanos: spent,
})

describe("the budget stop record", () => {
  it("reads the amounts the record carries instead of its prose", () => {
    const notice = budgetStopNotice(record(7, stop(540_000_000, 10_000_000)))
    expect(notice).toEqual({ spentUsdNanos: 540_000_000, budgetUsdNanos: 10_000_000 })
  })

  it("ignores every other record, including prose that only looks like a stop", () => {
    expect(budgetStopNotice(record(1, { content: "Budget exhausted: $1 settled of the $1 limit." }))).toBeNull()
    expect(budgetStopNotice(record(2, { role: "assistant", content: "hi" }))).toBeNull()
    expect(budgetStopNotice(record(3, { role: "system", content: "hi", budget_usd_nanos: 1 }))).toBeNull()
    expect(budgetStopNotice(record(4, { role: "system", content: "hi" }, "input"))).toBeNull()
  })

  it("offers only the newest stop, since an older one resumes nothing", () => {
    const records = [record(1, stop(10, 10)), record(2, { content: "hello" }), record(3, stop(20, 10))]
    expect(newestBudgetRecordId(records)).toBe(3)
    expect(newestBudgetRecordId([record(5, { content: "hello" })])).toBeNull()
  })
})
