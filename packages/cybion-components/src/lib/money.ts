// Money the user types in dollars and the Controller stores as integer
// nanodollars. Both the settings panel and the budget notice on the record edit
// the same amount, so the parsing lives here once instead of in each of them.

/**
 * The text a money field should show for an amount. Whole dollars stay whole and
 * cents stay cents; never exponential notation, which `String(1e-8)` would give
 * and which reads as garbage inside a text field.
 */
export function formatMoney(nanos: number): string {
  const whole = Math.floor(nanos / 1_000_000_000)
  const fraction = String(nanos % 1_000_000_000).padStart(9, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/**
 * What a keystroke is allowed to leave in the field: digits and at most one
 * decimal point, with a comma read as that point. `null` means the input is not
 * a partial amount at all and the caller should put the previous text back.
 */
export function sanitizeMoneyInput(raw: string): string | null {
  const normalized = raw.replace(/,/g, ".")
  return /^\d*\.?\d*$/.test(normalized) ? normalized : null
}

/**
 * The amount a field holds, in nanodollars, or `null` for "no amount": an empty
 * field, or the bare decimal point on its way to `0.5`. Rounding to whole
 * nanodollars keeps the stored value an integer, so comparisons stay exact.
 */
export function parseMoneyInput(text: string): number | null {
  if (text === "" || text === ".") return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? Math.round(Math.max(0, parsed) * 1_000_000_000) : null
}

/**
 * Settled spend the way a bill reads: cents. Anything under a cent is not zero
 * money, so it says so rather than rounding the charge away.
 */
export function formatSettledUsd(nanos: number): string {
  const value = nanos / 1_000_000_000
  return value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`
}
