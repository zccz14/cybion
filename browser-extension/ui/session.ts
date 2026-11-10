export const BASE_URL = "https://cybion.ntnl.io"
export const PENDING_KEY = "cybion.pendingThread"
export const ERROR_KEY = "cybion.lastError"

export type ThreadSummary = { id: string; title: string; display_status: string; updated_at: number }

/** 登录态只有一份，在 background 里维护；这里是它在页面侧的唯一入口。 */
export async function getToken(force = false): Promise<string> {
  const reply = await chrome.runtime.sendMessage({ type: "cybion:token", force })
  if (!reply?.token) throw new Error(reply?.error ?? "还没有 Cybion 的登录态：打开 cybion.ntnl.io 登录一次。")
  return reply.token as string
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const attempt = (token: string) =>
    fetch(BASE_URL + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
  let response = await attempt(await getToken())
  if (response.status === 401) response = await attempt(await getToken(true))
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(detail?.error ?? `Cybion 返回 ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const listThreads = () => call<{ items: ThreadSummary[] }>("/api/threads?limit=40")

export const createThread = (title?: string) =>
  call<{ id: string }>("/api/threads", { method: "POST", body: JSON.stringify(title ? { title } : {}) })
