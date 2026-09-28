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

export type UserInputView = { text: string; images: string[] }

// A user input payload is either plain text or Responses content parts:
// `input_text` carries the typed text and `input_image` each pasted data URL.
export function userInputView(payload: unknown): UserInputView {
  const object = historyPayloadObject(payload)
  if (typeof object?.content === "string") return { text: object.content, images: [] }
  const parts = Array.isArray(object?.content) ? object.content : []
  const text: string[] = []
  const images: string[] = []
  for (const part of parts) {
    const partObject = historyPayloadObject(part)
    if (partObject?.type === "input_text" && typeof partObject.text === "string") text.push(partObject.text)
    if (partObject?.type === "input_image" && typeof partObject.image_url === "string") images.push(partObject.image_url)
  }
  return { text: text.join(""), images }
}

export type BashFunctionCall = { workerId: string; command: string }

export function bashFunctionCall(payload: unknown): BashFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "bash" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  if (typeof args?.worker_id !== "string" || typeof args.command !== "string") return null
  return { workerId: args.worker_id, command: args.command }
}

function parseFunctionArguments(value: string): Record<string, unknown> | null {
  try {
    return historyPayloadObject(JSON.parse(value))
  } catch {
    // RECOVERY: Streamed arguments may be incomplete; keep the raw protocol event visible.
    return null
  }
}
