import type { HistoryRecord, ThreadHistoryWindow } from "./lib/thread-history"
import type { ThreadResponseView } from "./lib/thread-response"
import type { ThreadUsage } from "./lib/thread-usage"
import type { ThreadDisplayStatus } from "./lib/thread-status"

export type Language = "en" | "zh"

export type Thread = {
  id: string
  title: string
  status: "idle" | "running" | "failed"
  display_status: ThreadDisplayStatus
  running_summary: string | null
  created_by: "web" | "api"
  external_ref: string | null
  model: string
  upstream_id: string | null
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max"
  service_tier_fast: boolean
  context_budget_tokens: number | null
  minimal_mode: boolean | null
  image_generation_model: string | null
  /** `null` follows the account default; speech-to-text stays on either way. */
  audio_transcription_model: string | null
  max_loaded_manuals: number | null
  /** `null` follows the account default; the Manuals this Thread starts with. */
  initial_manual_ids: string[] | null
  archived_at: number | null
  context_tokens: number | null
  usage: ThreadUsage
  created_at: number
  updated_at: number
}

export type ThreadDefaults = {
  model: string
  upstream_id: string | null
  reasoning_effort: Thread["reasoning_effort"]
  service_tier_fast: boolean
  context_budget_tokens: number
  minimal_mode: boolean
  image_generation_model: string
  audio_transcription_model: string | null
  max_loaded_manuals: number
  /** The Manuals a new Thread is created with; every one of them is bound
   * before its first input. */
  initial_manual_ids: string[]
}

export type UpstreamCatalog = { id: string; name: string; models: string[]; error: string | null }
export type UpstreamModels = { upstreams: UpstreamCatalog[] }

export type ThreadPatch = Partial<Pick<Thread,
  "title" | "model" | "upstream_id" | "reasoning_effort" | "service_tier_fast" |
  "context_budget_tokens" | "minimal_mode" | "image_generation_model" |
  "audio_transcription_model" | "max_loaded_manuals" | "initial_manual_ids">> & { archived?: boolean }

export type RequestAck = { thread_id: string; record_idx: number; status: "accepted" }

export type HistoryWindow = ThreadHistoryWindow

/** The browser token the host hands over: an Auth Mini JWT whose audience includes Cybion. */
export type CybionTokenProvider = () => string | Promise<string>

export type CybionClientOptions = {
  /** Origin that serves the Cybion browser API, e.g. `https://cybion.ntnl.io`. */
  baseUrl: string
  getToken: CybionTokenProvider
  /** Swap the transport (tests, a proxy, a private gateway). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
}

export class CybionApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "CybionApiError"
    this.status = status
  }
}

/**
 * The Cybion browser API, addressed by a base URL and an Auth Mini JWT.
 *
 * Every call sends `Authorization: Bearer <jwt>`; a 401 is retried once with a
 * freshly minted token, because Auth Mini hands out short-lived access tokens and
 * a thread can stay open long enough for one to expire mid-conversation.
 */
export class CybionThreadClient {
  readonly baseUrl: string
  private readonly getToken: CybionTokenProvider
  private readonly fetchImpl: typeof fetch

  constructor(options: CybionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.getToken = options.getToken
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private readonly audioObjectUrls = new Map<string, Promise<string>>()
  audioObjectUrl = (reference: string, mediaType: string | null): Promise<string> => {
    const key = `${reference}:${mediaType ?? ""}`
    const cached = this.audioObjectUrls.get(key)
    if (cached) return cached
    const pending = this.object(reference, mediaType).then((blob) => URL.createObjectURL(blob))
    this.audioObjectUrls.set(key, pending)
    pending.catch(() => this.audioObjectUrls.delete(key))
    return pending
  }

  private url(path: string) {
    return `${this.baseUrl}${path}`
  }

  private async send(path: string, init: RequestInit, token: string) {
    return this.fetchImpl(this.url(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    })
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const first = await this.send(path, init, await this.getToken())
    const response = first.status === 401 ? await this.send(path, init, await this.getToken()) : first
    if (!response.ok) {
      const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string }
      throw new CybionApiError(body.error ?? response.statusText, response.status)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  thread(id: string) {
    return this.request<Thread>(`/api/threads/${encodeURIComponent(id)}`)
  }

  history(id: string, after: number) {
    return this.request<HistoryRecord[]>(`/api/threads/${encodeURIComponent(id)}/history?after=${after}`)
  }

  /** One page of the transcript, oldest first. The wire field is `has_older`. */
  async historyWindow(id: string, before?: number): Promise<HistoryWindow> {
    const query = before === undefined ? "" : `?before=${before}`
    const page = await this.request<{ records: HistoryRecord[]; has_older: boolean }>(`/api/threads/${encodeURIComponent(id)}/history/window${query}`)
    return { records: page.records, hasOlder: page.has_older }
  }

  response(id: string) {
    return this.request<ThreadResponseView | null>(`/api/threads/${encodeURIComponent(id)}/response`)
  }

  sendInput(id: string, input: { input: string; images: string[]; audios: string[] }) {
    return this.request<RequestAck>(`/api/threads/${encodeURIComponent(id)}/inputs`, {
      method: "POST",
      body: JSON.stringify({ input: input.input.trim(), images: input.images, audios: input.audios }),
    })
  }

  control(id: string, action: "cancel" | "continue" | "compact") {
    return this.request<unknown>(`/api/threads/${encodeURIComponent(id)}/${action}`, { method: "POST" })
  }

  update(id: string, patch: ThreadPatch) {
    return this.request<Thread>(`/api/threads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  }

  generateTitle(id: string) {
    return this.request<Thread>(`/api/threads/${encodeURIComponent(id)}/title`, { method: "POST" })
  }

  deleteThread(id: string) {
    return this.request<void>(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" })
  }

  modelCatalog(kind?: "image" | "sst") {
    const query = kind === undefined ? "" : `?kind=${kind}`
    return this.request<UpstreamModels>(`/api/integrations/upstreams/models${query}`)
  }

  defaults() {
    return this.request<ThreadDefaults>("/api/thread-defaults")
  }

  /** Audio and images the thread produced are served from the object store behind the same bearer token. */
  async object(reference: string, mediaType?: string | null): Promise<Blob> {
    const query = mediaType ? `?media_type=${encodeURIComponent(mediaType)}` : ""
    const path = `/api/objects/${encodeURIComponent(reference)}${query}`
    const first = await this.fetchImpl(this.url(path), {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
    })
    const response = first.status === 401
      ? await this.fetchImpl(this.url(path), { headers: { Authorization: `Bearer ${await this.getToken()}` } })
      : first
    if (!response.ok) throw new CybionApiError(response.statusText, response.status)
    return response.blob()
  }
}
