export type ThreadUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens: number
  cache_hit_rate: number | null
  /** Cost the upstream reported for this thread's calls, in USD nanodollars. */
  cost_usd_nanos: number
  /** How many of the thread's requests carry a reported cost. */
  cost_settled_requests: number
}

export const emptyThreadUsage: ThreadUsage = {
  input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0,
  cache_hit_rate: null, cost_usd_nanos: 0, cost_settled_requests: 0,
}

export function compactTokenCount(tokens: number) {
  return tokens.toLocaleString("en", { notation: "compact", maximumFractionDigits: 1 })
}

export function threadCacheRate(rate: number | null, language: "en" | "zh") {
  return rate === null ? "—" : rate.toLocaleString(language === "zh" ? "zh-CN" : "en", { style: "percent", maximumFractionDigits: 1 })
}

/** A reported cost, or `null` when no request of the thread has one yet. */
export function threadCost(usage: ThreadUsage, language: "en" | "zh") {
  if (usage.cost_settled_requests === 0) return null
  const usd = usage.cost_usd_nanos / 1_000_000_000
  const digits = usd >= 0.01 ? 4 : 6
  return `$${usd.toLocaleString(language === "zh" ? "zh-CN" : "en", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}
