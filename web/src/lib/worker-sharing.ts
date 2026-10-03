export type WorkerGrant = {
  grantee_user_id: string
  grant_id: string
  revoked_at: number | null
  revision: number
  synced_revision: number
  created_at: number
  updated_at: number
}

export function recipientError(value: string, userId: string | undefined) {
  if (!value || value !== userId) return null
  return "self"
}
