import { useState } from "react"
import { HourglassIcon, PlusIcon } from "lucide-react"

import type { Language } from "../api"
import { copyFor, fillCopy, type CopyKey } from "../copy"
import { DEFAULT_BUDGET_RAISE_USD_NANOS, MAX_BUDGET_USD_NANOS, type BudgetStopNotice } from "../lib/budget-stop"
import { formatMoney, formatSettledUsd, parseMoneyInput, sanitizeMoneyInput } from "../lib/money"
import { Button } from "../ui/button"
import { Input } from "../ui/input"

/**
 * The record a Thread leaves when its USD budget stopped it, restated in the
 * reader's language and — when the host can act on it — with the one control that
 * resumes the Thread: add an amount, so the limit becomes the settled spend plus
 * that amount, and continue.
 *
 * The Controller's own sentence stays in the payload for the model; this is what
 * the user reads, which is why both numbers come from the record rather than from
 * the prose around them.
 */
export function BudgetStopNotice({ notice, language, time, recordId, onRaise, pending }: {
  notice: BudgetStopNotice
  language: Language
  time: string
  recordId: number
  onRaise?: (addedUsdNanos: number) => void
  pending?: boolean
}) {
  const t = (key: CopyKey) => copyFor(language, key)
  const [draft, setDraft] = useState(formatMoney(DEFAULT_BUDGET_RAISE_USD_NANOS))
  const added = parseMoneyInput(draft)
  const limit = added === null ? null : notice.spentUsdNanos + added
  const overCeiling = limit !== null && limit > MAX_BUDGET_USD_NANOS
  return <div data-slot="budget-stop-notice" className="flex items-start gap-3 rounded-xl border border-amber-600/35 bg-amber-500/5 px-3 py-3 dark:border-amber-400/30 dark:bg-amber-400/5">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 ring-1 ring-amber-600/20 dark:text-amber-400 dark:ring-amber-400/25">
      <HourglassIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-amber-700 dark:text-amber-300">{t("recordBudgetExhausted")}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-1 text-sm leading-6">{fillCopy(t("budgetExhausted"), { spent: formatSettledUsd(notice.spentUsdNanos), budget: formatSettledUsd(notice.budgetUsdNanos) })}</p>
      {onRaise && <form className="mt-2 flex flex-col gap-2" onSubmit={(event) => {
        event.preventDefault()
        if (added === null || overCeiling || pending) return
        onRaise(added)
      }}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`budget-raise-${recordId}`} className="text-xs font-medium text-muted-foreground">{t("budgetRaiseLabel")}</label>
            <Input
              id={`budget-raise-${recordId}`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={overCeiling}
              className="h-8 w-28"
              value={draft}
              onChange={(event) => {
                const raw = sanitizeMoneyInput(event.target.value)
                if (raw === null) { event.target.value = draft; return }
                setDraft(raw)
              }}
            />
          </div>
          <Button type="submit" size="sm" disabled={added === null || overCeiling || pending}><PlusIcon data-icon="inline-start" />{t("budgetRaiseAction")}</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("budgetRaiseHint")}
          {limit !== null && !overCeiling && <> {fillCopy(t("budgetRaiseNewLimit"), { limit: formatSettledUsd(limit) })}</>}
        </p>
      </form>}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground"><span className="font-mono">#{recordId}</span></div>
    </div>
  </div>
}
