import type { ThreadDisplayStatus } from "./thread-status.ts"
import type { ThreadUsage } from "./thread-usage.ts"
import type { ThreadResponseView } from "./thread-response.ts"

export type SharingRequest = <T>(path: string, init?: RequestInit) => Promise<T>
export type ThreadGrant = {
  grantee_user_id: string; grant_id: string; permission: "viewer"; revoked_at: number | null
  revision: number; synced_revision: number; created_at: number; updated_at: number
}
export type SharedThread = {
  id: string; owner_user_id: string; grant_id: string; access: "viewer"
  title: string; status: "idle" | "running" | "failed"; display_status: ThreadDisplayStatus
  usage: ThreadUsage; created_at: number; updated_at: number; shared_at: number
}
export type SharedThreadPageData = { items: SharedThread[]; next_cursor: string | null }
export type SharedResponse = Pick<ThreadResponseView, "started_at" | "status"> & {
  response: Pick<ThreadResponseView["response"], "output" | "completed">
}

export function sharedThreadPath(owner: string, thread: string) {
  return `/shared-threads/${encodeURIComponent(owner)}/${encodeURIComponent(thread)}`
}
export function sharedThreadReturnHash(hash: string): string | null {
  const match = /^#\/shared-threads\/([A-Za-z0-9.-]{1,128})\/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})(?:\?.*)?$/.exec(hash)
  return match ? `#${sharedThreadPath(match[1], match[2])}` : null
}
export function sharingAccessLost(error: unknown) {
  return error instanceof Error && "status" in error && [401, 403, 404].includes(Number(error.status))
}
export function sharedThreadQueryKey(session: string | null | undefined, viewer: string, owner: string, thread: string) {
  return ["shared-thread", session, viewer, owner, thread] as const
}
