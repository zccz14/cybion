export function historyPayloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null
}

function textParts(value: unknown, separator: string) {
  if (!Array.isArray(value)) return ""
  return value.flatMap((part: unknown) => {
    const object = historyPayloadObject(part)
    if (typeof object?.text === "string") return [object.text]
    if (typeof object?.refusal === "string") return [object.refusal]
    return []
  }).join(separator)
}

export function historyPayloadText(payload: unknown): string {
  const object = historyPayloadObject(payload)
  if (object?.type === "reasoning") {
    const summary = textParts(object.summary, "\n\n")
    if (summary) return summary
  }
  if (typeof object?.content === "string") return object.content
  if (object?.type === "message") return textParts(object.content, "")
  const content = textParts(object?.content, "")
  if (content) return content
  if (typeof object?.output === "string") return object.output
  return JSON.stringify(payload, null, 2) ?? String(payload)
}
