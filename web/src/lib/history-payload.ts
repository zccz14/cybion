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

// The `view_image` call as stored in the Responses item: the Worker and the
// path of the image file it reads.
export type ViewImageFunctionCall = { workerId: string; path: string }

export function viewImageFunctionCall(payload: unknown): ViewImageFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "view_image" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  if (typeof args?.worker_id !== "string" || typeof args.path !== "string") return null
  return { workerId: args.worker_id, path: args.path }
}

export type WebSearchFunctionCall = { query: string }

// The intercepted `normai_web_search` call as stored in the Responses item: one
// trimmed query. Incomplete or malformed arguments keep the generic rendering.
export function webSearchFunctionCall(payload: unknown): WebSearchFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "normai_web_search" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  if (typeof args?.query !== "string" || args.query.trim() === "") return null
  return { query: args.query.trim() }
}

export type ImageGenerationFunctionCall = { prompt: string; referenceImages: number[] }

// The intercepted `normai_image_generation` call as stored in the Responses
// item: one trimmed prompt plus the one-based positions of the pictures
// attached to the turn's input that the call references.
export function imageGenerationFunctionCall(payload: unknown): ImageGenerationFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "normai_image_generation" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  if (typeof args?.prompt !== "string" || args.prompt.trim() === "") return null
  return { prompt: args.prompt.trim(), referenceImages: referenceImagePositions(args.reference_images) }
}

// Positions that cannot name an attached picture are left out of the display
// line; the raw payload disclosure keeps the full attempted argument.
function referenceImagePositions(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((position): position is number => typeof position === "number" && Number.isInteger(position) && position >= 1)
}

function parseFunctionArguments(value: string): Record<string, unknown> | null {
  try {
    return historyPayloadObject(JSON.parse(value))
  } catch {
    // RECOVERY: Streamed arguments may be incomplete; keep the raw protocol event visible.
    return null
  }
}

// The Worker writes screenshots as PNG files; its `data` field is that file's base64.
const PNG_BASE64_PREFIX = "iVBORw0KGgo"

// A ledger-marked screenshot output carries the Worker result as a JSON string
// in `output`; a successful capture becomes an openable PNG data URL and a
// failed capture keeps the ordinary tool output rendering.
export function screenshotImageSource(payload: unknown): string | null {
  const output = historyPayloadObject(payload)?.output
  if (typeof output !== "string") return null
  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    // RECOVERY: a result that is not JSON stays visible as the ordinary tool output.
    return null
  }
  const data = historyPayloadObject(result)?.data
  return typeof data === "string" && data.startsWith(PNG_BASE64_PREFIX)
    ? `data:image/png;base64,${data}`
    : null
}

// A view_image output carries its file as an input_image part; the server
// resolves the stored object reference into the data URL before the browser
// sees it, so the part's image_url opens directly.
export function viewedImageSource(payload: unknown): string | null {
  const output = historyPayloadObject(payload)?.output
  if (!Array.isArray(output)) return null
  for (const part of output) {
    const object = historyPayloadObject(part)
    if (object?.type === "input_image" && typeof object.image_url === "string" && object.image_url !== "") return object.image_url
  }
  return null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

function integerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

// The `browser_control` call as stored in the Responses item: the action plus
// the argument fields that action carries. An unknown action or a missing
// field keeps the generic protocol rendering.
export type BrowserControlFunctionCall =
  | { action: "navigate" | "open"; url: string }
  | { action: "evaluate"; text: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "screenshot" }

export function browserControlFunctionCall(payload: unknown): BrowserControlFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "browser_control" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  const action = nonEmptyString(args?.action)
  if (action === null) return null
  switch (action) {
    case "navigate":
    case "open": {
      const url = nonEmptyString(args?.url)
      return url === null ? null : { action, url }
    }
    case "evaluate": {
      const script = nonEmptyString(args?.text)
      return script === null ? null : { action, text: script }
    }
    case "click": {
      const selector = nonEmptyString(args?.selector)
      return selector === null ? null : { action, selector }
    }
    case "type": {
      const selector = nonEmptyString(args?.selector)
      const text = nonEmptyString(args?.text)
      return selector === null || text === null ? null : { action, selector, text }
    }
    case "screenshot":
      return { action }
    default:
      return null
  }
}

// The `computer_use` call as stored in the Responses item: the action plus its
// coordinates or text. An unknown action or a missing field keeps the generic
// protocol rendering.
export type ComputerUseFunctionCall =
  | { action: "move"; x: number; y: number }
  | { action: "click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "screenshot" }

export function computerUseFunctionCall(payload: unknown): ComputerUseFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || object.name !== "computer_use" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  const action = nonEmptyString(args?.action)
  if (action === null) return null
  switch (action) {
    case "move":
    case "click": {
      const x = integerNumber(args?.x)
      const y = integerNumber(args?.y)
      return x === null || y === null ? null : { action, x, y }
    }
    case "type": {
      const text = nonEmptyString(args?.text)
      return text === null ? null : { action, text }
    }
    case "screenshot":
      return { action }
    default:
      return null
  }
}

// The controller-side Cybion tools as stored in the Responses item. The
// list tools carry no displayable arguments; a machine update is a call that
// names its machine, and a manual write names its manual or, when creating,
// its title. A create shows whichever fields it provides; missing identifiers
// keep the generic protocol rendering.
export type CybionToolFunctionCall =
  | { tool: "load_manual"; manualId: string }
  | { tool: "unload_manual"; manualId: string }
  | { tool: "write_manual"; manualId: string | null; trashed: boolean; name: string | null; parentId: string | null }
  | { tool: "list_manuals" }
  | { tool: "cybion_list_workers" }
  | { tool: "cybion_list_ultimate_machines" }
  | { tool: "cybion_get_ultimate_machine"; machineId: string }
  | { tool: "cybion_set_ultimate_machine"; machineId: string | null; name: string | null; workerId: string | null; intervalSeconds: number | null; enabled: boolean | null; command: string | null; intent: string | null }
  | { tool: "cybion_delete_ultimate_machine"; machineId: string }
  | { tool: "add_notes"; texts: string[] }
  | { tool: "cross_out_notes"; noteIds: string[] }

export function cybionToolFunctionCall(payload: unknown): CybionToolFunctionCall | null {
  const object = historyPayloadObject(payload)
  if (object?.type !== "function_call" || typeof object.name !== "string" || typeof object.arguments !== "string") return null
  const args = parseFunctionArguments(object.arguments)
  if (args === null) return null
  switch (object.name) {
    // A load or unload names a Manual, so the card shows the Manual's title and
    // its Use When description.
    case "load_manual": {
      const manualId = nonEmptyString(args.manual_id)
      return manualId === null ? null : { tool: "load_manual", manualId }
    }
    case "unload_manual": {
      const manualId = nonEmptyString(args.manual_id)
      return manualId === null ? null : { tool: "unload_manual", manualId }
    }
    case "write_manual": {
      const manualId = nonEmptyString(args.manual_id)
      const name = nonEmptyString(args.name)
      return manualId === null && name === null
        ? null
        : { tool: "write_manual", manualId, trashed: args.parent_id === "TRASH", name, parentId: nonEmptyString(args.parent_id) }
    }
    case "add_notes": {
      const items = Array.isArray(args.items) ? args.items : []
      const texts = items.flatMap((item: unknown) => {
        const object = historyPayloadObject(item)
        return typeof object?.text === "string" && object.text.trim() !== "" ? [object.text.trim()] : []
      })
      return texts.length === 0 ? null : { tool: "add_notes", texts }
    }
    case "cross_out_notes": {
      const noteIds = (Array.isArray(args.note_ids) ? args.note_ids : [])
        .filter((id): id is string => typeof id === "string" && id.trim() !== "")
      return noteIds.length === 0 ? null : { tool: "cross_out_notes", noteIds }
    }
    case "list_manuals":
      return { tool: "list_manuals" }
    case "cybion_list_workers":
      return { tool: "cybion_list_workers" }
    case "cybion_list_ultimate_machines":
      return { tool: "cybion_list_ultimate_machines" }
    case "cybion_get_ultimate_machine": {
      const machineId = nonEmptyString(args.machine_id)
      return machineId === null ? null : { tool: "cybion_get_ultimate_machine", machineId }
    }
    case "cybion_delete_ultimate_machine": {
      const machineId = nonEmptyString(args.machine_id)
      return machineId === null ? null : { tool: "cybion_delete_ultimate_machine", machineId }
    }
    case "cybion_set_ultimate_machine": {
      const call: CybionToolFunctionCall = {
        tool: "cybion_set_ultimate_machine",
        machineId: nonEmptyString(args.machine_id),
        name: nonEmptyString(args.name),
        workerId: nonEmptyString(args.worker_id),
        intervalSeconds: integerNumber(args.interval_seconds),
        enabled: typeof args.enabled === "boolean" ? args.enabled : null,
        command: nonEmptyString(args.command),
        intent: nonEmptyString(args.intent),
      }
      const provided = call.machineId !== null || call.name !== null || call.workerId !== null
        || call.intervalSeconds !== null || call.enabled !== null || call.command !== null || call.intent !== null
      return provided ? call : null
    }
    default:
      return null
  }
}
