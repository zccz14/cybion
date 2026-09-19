export type ThreadUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens: number
  cache_hit_rate: number | null
  unreported_requests: number
}

export const emptyThreadUsage: ThreadUsage = {
  input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_tokens: 0,
  cache_hit_rate: null, unreported_requests: 0,
}

export function compactTokenCount(tokens: number) {
  return tokens.toLocaleString("en", { notation: "compact", maximumFractionDigits: 1 })
}

export function threadCacheRate(rate: number | null, language: "en" | "zh") {
  return rate === null ? "—" : rate.toLocaleString(language === "zh" ? "zh-CN" : "en", { style: "percent", maximumFractionDigits: 1 })
}
