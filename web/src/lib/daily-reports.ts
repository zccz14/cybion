export type ReportRequest = <T>(path: string, init?: RequestInit) => Promise<T>
export type ReportDocument = { sections: { key: string; items: { text: string; evidence: number[] }[] }[] }
export type ReportSummary = {
  id: number; date: string; thread_id: string | null; source_fingerprint: string
  source_manifest: { records: { id: number; kind: string; created_at: number }[]; background_input_id: number | null; children: { thread_id: string; source_fingerprint: string; summary_id: number | null }[] }
  executor_thread_id: string | null; input_record_id: number | null; audit_id: number | null; execution_kind: "legacy" | "thread"
  prompt_version: number; model: string; upstream_name: string; language: string
  status: "running" | "completed" | "failed"; content: ReportDocument | null; error: string | null
  started_at: number; finished_at: number | null; requests: number; input_tokens: number; output_tokens: number; missing_usage_requests: number
}
export type SummaryState = { latest: ReportSummary | null; saved: ReportSummary | null; stale: boolean }
export type ReportJob = {
  id: number; date: string; thread_id: string | null; language: string; status: "running" | "completed" | "failed"
  executor_thread_id: string | null; input_record_id: number | null; source_cutoff: number | null
  requests: number; input_tokens: number; output_tokens: number; missing_usage_requests: number
  completed_threads: number; total_threads: number; phase: string; started_at: number; finished_at: number | null; error: string | null
}
export type ReportThread = { id: string; title: string; model: string; purpose: "reports"; status: "idle" | "running" | "failed" }
export type DailyReport = {
  date: string; timezone: string; generated_at: number; active_thread_count: number; activity_records: number
  input_records: number; requests: number; total_tokens: number
  threads: { id: string; title: string; summary: string | null; activity_count: number; input_count: number; request_count: number; total_tokens: number; last_activity_at: number; daily_summary: SummaryState }[]
  summary: SummaryState
  generation: { resumable_job_id: number | null; report_thread: ReportThread | null; job: ReportJob | null; running_job: ReportJob | null; generator: { model: string; upstream_name: string } | null }
}

export function evidencePath(id: number) { return `/history?id=${encodeURIComponent(id)}` }

export function reportAuditPath(threadId: string) { return `/reasoning-audits?thread_id=${encodeURIComponent(threadId)}` }
