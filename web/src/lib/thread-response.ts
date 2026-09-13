export type ThreadResponseView = {
  audit_id: number
  input_record_id: number | null
  started_at: number
  status: string
  response: {
    response_id: string | null
    completed: boolean
    output: { item: Record<string, unknown>; done: boolean; record_id: number | null }[]
    server_model: string | null
    model_verifications: string[]
    safety_buffering: { use_cases: string[]; reasons: string[]; show_buffering_ui: boolean; retry_model: string | null } | null
    rate_limits: { limit_id: string | null; primary: { used_percent: number } | null; secondary: { used_percent: number } | null }[]
    usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null
    error: { code: string; detail?: unknown } | null
  }
}

export function generatedImageSource(payload: unknown): string | null {
  if (!payload || typeof payload !== "object"
    || !("type" in payload) || payload.type !== "image_generation_call"
    || !("result" in payload) || typeof payload.result !== "string" || !payload.result) return null
  const format = "output_format" in payload ? payload.output_format : "png"
  if (format !== "png" && format !== "jpeg" && format !== "webp") return null
  return `data:image/${format};base64,${payload.result}`
}

export function pendingResponseRecords(view: ThreadResponseView | null | undefined, history: { id: number }[], threadId: string) {
  if (!view) return []
  const durableIds = new Set(history.map((record) => record.id))
  return view.response.output.flatMap((output, index) => {
    if (output.record_id !== null && durableIds.has(output.record_id)) return []
    const item = output.item
    const parts = item.type === "reasoning" ? item.summary : item.content
    const content = Array.isArray(parts) ? parts.flatMap((part: unknown) => {
      if (typeof part !== "object" || part === null) return []
      if ("text" in part && typeof part.text === "string") return [part.text]
      if ("refusal" in part && typeof part.refusal === "string") return [part.refusal]
      return []
    }).join(item.type === "reasoning" ? "\n\n" : "") : ""
    return [{
      id: output.record_id ?? -(index + 1), thread_id: threadId, request_input_id: view.input_record_id,
      role: item.type === "message" || item.type === "reasoning" ? "assistant" as const : "tool" as const,
      content, kind: "response_output" as const, payload: item, visible: true, created_at: view.started_at,
    }]
  })
}
