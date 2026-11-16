import { describe, expect, it } from "vitest"
import { formatMoney, formatSettledUsd, parseMoneyInput, sanitizeMoneyInput } from "./money"

describe("money fields", () => {
  it("shows an amount without exponential notation", () => {
    expect(formatMoney(1_000_000_000)).toBe("1")
    expect(formatMoney(10_000_000)).toBe("0.01")
    expect(formatMoney(250_000_000)).toBe("0.25")
    expect(formatMoney(10)).toBe("0.00000001")
    expect(formatMoney(0)).toBe("0")
  })

  it("keeps a half-typed decimal point in the field", () => {
    // The whole point of the draft: "0." is a legal keystroke, not the number 0.
    expect(sanitizeMoneyInput("0.")).toBe("0.")
    expect(sanitizeMoneyInput("0.0")).toBe("0.0")
    expect(sanitizeMoneyInput("0,5")).toBe("0.5")
    expect(sanitizeMoneyInput("1.2.3")).toBeNull()
    expect(sanitizeMoneyInput("abc")).toBeNull()
    expect(sanitizeMoneyInput("-1")).toBeNull()
  })

  it("parses a field into whole nanodollars, and partial input as no amount", () => {
    expect(parseMoneyInput("0.01")).toBe(10_000_000)
    expect(parseMoneyInput("1")).toBe(1_000_000_000)
    expect(parseMoneyInput("0")).toBe(0)
    expect(parseMoneyInput("")).toBeNull()
    expect(parseMoneyInput(".")).toBeNull()
  })

  it("reads settled spend in cents and never rounds a charge away", () => {
    expect(formatSettledUsd(540_000_000)).toBe("$0.54")
    expect(formatSettledUsd(1_000_000)).toBe("<$0.01")
    expect(formatSettledUsd(0)).toBe("$0.00")
  })
})
