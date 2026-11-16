import { historyPayloadObject } from "./history-payload"
import type { HistoryRecord } from "./thread-history"

/** What a budget-stopped Thread tells the conversation: the two amounts it was judged on. */
export type BudgetStopNotice = { spentUsdNanos: number; budgetUsdNanos: number }

/**
 * The record the kernel leaves when it stops a Thread at its USD limit. It carries
 * the amounts as numbers rather than only in prose, so a host can restate them in
 * the reader's language and offer to raise the limit from the record itself.
 */
export function budgetStopNotice(record: HistoryRecord): BudgetStopNotice | null {
  if (record.kind !== "activity") return null
  const payload = historyPayloadObject(record.payload)
  if (payload === null || payload.role !== "system") return null
  const spent = payload.spent_usd_nanos
  const budget = payload.budget_usd_nanos
  if (typeof spent !== "number" || typeof budget !== "number") return null
  return { spentUsdNanos: spent, budgetUsdNanos: budget }
}

/**
 * The one budget record that may still be acted on. Earlier ones were answered or
 * superseded, so offering to raise their limit would resume nothing.
 */
export function newestBudgetRecordId(records: readonly HistoryRecord[]): number | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (budgetStopNotice(records[index])) return records[index].id
  }
  return null
}

/** One dollar: enough to finish a turn without asking the user to do arithmetic. */
export const DEFAULT_BUDGET_RAISE_USD_NANOS = 1_000_000_000

/** The Controller refuses a limit above $10,000, so the panel never offers one. */
export const MAX_BUDGET_USD_NANOS = 10_000_000_000_000
