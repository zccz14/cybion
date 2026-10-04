// Auth Mini mints a session's audiences once, at login, and refresh keeps that
// same set. These helpers answer whether the session's token can still reach
// everything this deployment needs, so an audience-stale session signs out and
// re-logs instead of failing every request.

/** Audiences the token does not carry; tokens this layer cannot read report none. */
export function missingAudiences(token: string, expected: readonly string[]) {
  let audiences: string[]
  try {
    const encoded = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), "="))) as { aud?: unknown }
    audiences = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud.filter((value): value is string => typeof value === "string") : []
  } catch {
    // FALLBACK: an unreadable token is left to the provider's own verification.
    return []
  }
  return expected.filter((audience) => !audiences.includes(audience))
}
