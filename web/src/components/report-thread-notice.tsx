import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { reportAuditPath } from "@/lib/daily-reports"

export function ReportThreadNotice({ id, language }: { id: string; language: "en" | "zh" }) {
  const zh = language === "zh"
  return <div data-slot="report-thread-notice" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
    <Badge variant="outline">{zh ? "报告 Thread" : "Report Thread"}</Badge>
    <p className="min-w-0 flex-1 basis-64">{zh ? "仅可使用 Cybion 的 Thread 列表、历史读取、报表读取和版本更新工具；不能操作 Worker。对话与日报按钮共用此 Thread，模型调用进入推理审计。" : "Limited to Cybion Thread listing, history reading, report reading and version updates; no Worker access. Chat and the daily-report button share this Thread and its reasoning audits."}</p>
    <Link className="underline" to={reportAuditPath(id)}>{zh ? "查看推理审计" : "View reasoning audits"}</Link>
    <Link className="underline" to="/insights">{zh ? "查看日报" : "View daily reports"}</Link>
  </div>
}
