export type WorkerCallAudit = {
  id: string
  caller_user_id: string
  has_details: boolean
  worker_id: string
  worker_label: string | null
  worker_hostname: string | null
  worker_version: string | null
  worker_resource: Record<string, unknown> | null
  thread_id: string
  thread_title: string
  input_record_id: number | null
  name: string
  arguments: Record<string, unknown> | null
  status: "queued" | "delivered" | "completed" | "failed"
  result: unknown
  error: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
}
export type WorkerCallAuditPage = {
  items: WorkerCallAudit[]
  total: number
  page: number
  page_size: number
}

export function ownWorkerCall(item: WorkerCallAudit, userId: string | undefined) {
  return Boolean(userId && item.caller_user_id === userId)
}
