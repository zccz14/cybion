export type ThreadResponseView = {
  audit_id: number
  input_record_id: number | null
  started_at: number
  status: string
  response: {
    completed: boolean
    output: { item: Record<string, unknown>; done: boolean; record_id: number | null }[]
    safety_buffering: { reasons: string[]; show_buffering_ui: boolean } | null
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

export function pendingResponseRecords(view: (Pick<ThreadResponseView, "started_at" | "status"> & { response: Pick<ThreadResponseView["response"], "output"> }) | null | undefined, history: { id: number }[], threadId: string) {
  if (!view || view.status === "cancelled") return []
  const durableIds = new Set(history.map((record) => record.id))
  return view.response.output.flatMap((output, index) => {
    if (output.record_id !== null && durableIds.has(output.record_id)) return []
    return [{
      id: output.record_id ?? -(index + 1), thread_id: threadId,
      kind: "response_output" as const, payload: output.item, created_at: view.started_at,
    }]
  })
}

export type ThreadAction = "cancel" | "continue" | "compact"

type ThreadActionRecord = { kind: string; payload: unknown }

export function threadControlAction(record: ThreadActionRecord): ThreadAction | null {
  const payload = record.payload
  if (record.kind !== "activity" || !payload || typeof payload !== "object"
    || !("type" in payload) || payload.type !== "thread_control" || !("action" in payload)) return null
  const action = payload.action
  return action === "cancel" || action === "continue" || action === "compact" ? action : null
}
