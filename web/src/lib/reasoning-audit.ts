export function auditCacheRate(inputTokens: number | null, cachedTokens: number | null, language: string) {
  if (inputTokens === null || inputTokens <= 0 || cachedTokens === null) return "—"
  return (cachedTokens / inputTokens).toLocaleString(language === "zh" ? "zh-CN" : "en", {
    style: "percent",
    maximumFractionDigits: 1,
  })
}

/**
 * The console URL of the gateway that recorded (and billed) one call, or `null`
 * when the audit row does not say which upstream served it.
 *
 * The request ID is the gateway's own: a chained gateway mints it and hands the
 * same value down the chain, so whichever console the row names is the one that
 * can resolve it.
 */
export function gatewayAuditUrl(upstreamBaseUrl: string | null, requestId: string) {
  if (!upstreamBaseUrl) return null
  let origin: string
  try {
    const url = new URL(upstreamBaseUrl)
    origin = `${url.protocol}//${url.host}`
  } catch {
    return null
  }
  return `${origin}/#/audit/${encodeURIComponent(requestId)}`
}
