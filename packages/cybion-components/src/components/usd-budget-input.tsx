import { useState } from "react"

import { formatMoney, parseMoneyInput, sanitizeMoneyInput } from "../lib/money"
import { Input } from "../ui/input"

/**
 * A dollar amount the user types, stored as integer nanodollars.
 *
 * The text in the box is a draft first and a number second: a controlled field
 * that renders `String(nanos / 1e9)` rewrites "0." to "0" on the keystroke,
 * because `Number("0.")` is 0, and the decimal point can never be typed. A
 * `type="number"` field has the same problem from the other side, since the
 * browser sanitizes a half-typed decimal away. So the draft keeps exactly what
 * the user typed, only digits and one point get through, and the value commits
 * as soon as it parses.
 */
export function UsdBudgetInput({ id, value, fallback, disabled, invalid, className, onChange, onBlur }: {
  id: string
  /** The amount in nanodollars, or `null` for "no amount" (empty follows the default). */
  value: number | null
  /** Shown as the placeholder while the field is empty. */
  fallback?: number
  disabled?: boolean
  invalid?: boolean
  className?: string
  onChange: (value: number | null) => void
  onBlur?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? (value === null ? "" : formatMoney(value))
  return <Input
    id={id}
    type="text"
    inputMode="decimal"
    autoComplete="off"
    className={className}
    disabled={disabled}
    aria-invalid={invalid}
    placeholder={fallback === undefined ? "0" : formatMoney(fallback)}
    value={text}
    onChange={(event) => {
      const raw = sanitizeMoneyInput(event.target.value)
      if (raw === null) {
        // A rejected keystroke changes no state, so React does not re-render: put
        // the old text back into the DOM by hand.
        event.target.value = text
        return
      }
      setDraft(raw)
      onChange(parseMoneyInput(raw))
    }}
    onBlur={() => { setDraft(null); onBlur?.() }}
  />
}
