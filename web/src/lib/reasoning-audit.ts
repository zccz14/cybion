export function auditCacheRate(inputTokens: number | null, cachedTokens: number | null, language: string) {
  if (inputTokens === null || inputTokens <= 0 || cachedTokens === null) return "—"
  return (cachedTokens / inputTokens).toLocaleString(language === "zh" ? "zh-CN" : "en", {
    style: "percent",
    maximumFractionDigits: 1,
  })
}

export function openaiAuditUrl(requestId: string) {
  return `https://openai.ntnl.io/#/audit/${encodeURIComponent(requestId)}`
}
