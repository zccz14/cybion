import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { formattedTime } from "@/lib/time"
import { ownedDevice, type Device } from "@/lib/worker-onboarding"
import { ownWorkerCall, type WorkerCallAudit, type WorkerCallAuditPage } from "@/lib/worker-audit"

const copy = {
  en: {
    workers: "Workers",
    auditStatus: "Status",
    auditAll: "All statuses",
    auditThread: "Thread",
    auditStarted: "Started",
    workerAudit: "Worker call audit",
    workerAuditDescription: "Calls on Workers you own, including calls from people you granted access to. Shared Worker results remain in your Threads.",
    workerAuditEmpty: "No Worker calls yet.",
    workerCall: "Call",
    workerArguments: "Arguments",
    workerResult: "Result",
    workerQueued: "Queued",
    workerDelivered: "Delivered",
    workerCancelled: "Cancelled",
    workerCompleted: "Completed",
    workerFailed: "Failed",
    workerAuditRange: "{from}–{to} of {total} calls",
    previous: "Previous",
    next: "Next",
    pageSize: "Per page",
    refresh: "Refresh details", details: "Arguments and result", caller: "Caller", privateThread: "Private Thread", retry: "Retry", loading: "Loading details…", unavailable: "Details unavailable", resource: "Worker resource",
  },
  zh: {
    workers: "Worker",
    auditStatus: "状态",
    auditAll: "全部状态",
    auditThread: "线程",
    auditStarted: "发起时间",
    workerAudit: "Worker 调用审计",
    workerAuditDescription: "展示自有 Worker 上的调用，包括被授权用户发起的任务。使用他人共享设备的结果请在对应 Thread 中查看。",
    workerAuditEmpty: "尚无 Worker 调用。",
    workerCall: "调用",
    workerArguments: "参数",
    workerResult: "结果",
    workerQueued: "排队",
    workerDelivered: "已投递",
    workerCancelled: "已取消",
    workerCompleted: "已完成",
    workerFailed: "失败",
    workerAuditRange: "第 {from}–{to} 条，共 {total} 次调用",
    previous: "上一页",
    next: "下一页",
    pageSize: "每页",
    refresh: "刷新详情", details: "参数与结果", caller: "调用者", privateThread: "私有 Thread", retry: "重试", loading: "正在加载详情…", unavailable: "详情不可用", resource: "Worker 资源",
  },
}

type Props = { language: "zh" | "en"; sessionId: string | null | undefined; request: <T>(path: string, init?: RequestInit) => Promise<T> }
export function WorkerAudit(props: Props) { return <WorkerAuditSession key={props.sessionId} {...props} /> }
function WorkerAuditSession({ language, sessionId, request }: Props) {
  const t = (key: keyof typeof copy.en) => copy[language][key]
  const identity = useQuery({ queryKey: ["me", sessionId], queryFn: ({ signal }) => request<{ user_id: string }>("/api/me", { signal }), staleTime: 60000, retry: false })
  const [status, setStatus] = useState<WorkerCallAudit["status"] | "all">("all")
  const [workerId, setWorkerId] = useState("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const workers = useQuery({ queryKey: ["workers", sessionId], queryFn: ({ signal }) => request<Device[]>("/api/workers", { signal }), refetchInterval: 5000 })
  const query = useQuery({
    queryKey: ["worker-calls", sessionId, status, workerId, page, pageSize],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (status !== "all") params.set("status", status)
      if (workerId !== "all") params.set("worker_id", workerId)
      return request<WorkerCallAuditPage>(`/api/worker-calls?${params}`, { signal })
    },
    refetchInterval: 2000,
  })
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize))
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])
  const rangeStart = query.data?.total ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = query.data?.items.length ? rangeStart + query.data.items.length - 1 : 0
  const range = t("workerAuditRange").replace("{from}", String(rangeStart)).replace("{to}", String(rangeEnd)).replace("{total}", String(query.data?.total ?? 0))
  return <>
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><CardTitle>{t("workerAudit")}</CardTitle><CardDescription>{t("workerAuditDescription")}</CardDescription></div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onValueChange={(value) => { setStatus(value as WorkerCallAudit["status"] | "all"); setPage(1) }}>
            <SelectTrigger aria-label={t("auditStatus")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="all">{t("auditAll")}</SelectItem><SelectItem value="queued">{t("workerQueued")}</SelectItem><SelectItem value="delivered">{t("workerDelivered")}</SelectItem><SelectItem value="cancelled">{t("workerCancelled")}</SelectItem><SelectItem value="completed">{t("workerCompleted")}</SelectItem><SelectItem value="failed">{t("workerFailed")}</SelectItem></SelectGroup></SelectContent>
          </Select>
          <Select value={workerId} onValueChange={(value) => { setWorkerId(value); setPage(1) }}>
            <SelectTrigger aria-label={t("workers")} size="sm"><SelectValue placeholder={t("workers")} /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="all">{t("workers")}</SelectItem>{workers.data?.filter(ownedDevice).map((worker) => <SelectItem key={worker.id} value={worker.id}>{worker.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}>
            <SelectTrigger aria-label={t("pageSize")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectGroup></SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {identity.error && <RequestError label={t("retry")} error={identity.error} onRetry={() => void identity.refetch()} />}
        {workers.error && <RequestError label={t("retry")} error={workers.error} onRetry={() => void workers.refetch()} />}
        {query.error && <RequestError label={t("retry")} error={query.error} onRetry={() => void query.refetch()} />}
        {!query.data && !query.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("workerAudit")}</div>}
        {query.data && query.data.items.length === 0 && <p className="py-8 text-sm text-muted-foreground">{t("workerAuditEmpty")}</p>}
        {query.data && query.data.items.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[58rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t("workerCall")}</th><th className="px-3 py-2 font-medium">{t("workers")}</th><th className="px-3 py-2 font-medium">{t("auditThread")}</th><th className="px-3 py-2 font-medium">{t("auditStatus")}</th><th className="px-3 py-2 font-medium">{t("auditStarted")}</th><th className="px-3 py-2 font-medium">{t("workerResult")}</th></tr></thead><tbody className="divide-y">{query.data.items.map((item) => <WorkerAuditRow key={`${sessionId}:${item.id}`} item={item} language={language} sessionId={sessionId} userId={identity.data?.user_id} request={request} />)}</tbody></table></div>}
        {query.data && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{range}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t("previous")}</Button><Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>{t("next")}</Button></div></div>}
      </CardContent>
    </Card>
  </>
}

function RequestError({ error, onRetry, label }: { error: Error; onRetry: () => void; label: string }) {
  return <Alert variant="destructive"><AlertDescription>{error.message}<Button variant="outline" size="sm" onClick={onRetry}>{label}</Button></AlertDescription></Alert>
}

function WorkerAuditRow({ item, language, sessionId, userId, request }: Props & { item: WorkerCallAudit; userId: string | undefined }) {
  const t = copy[language]
  const [open, setOpen] = useState(false)
  const detail = useQuery({
    queryKey: ["worker-call-detail", sessionId, userId, item.id, item.status, item.completed_at],
    queryFn: ({ signal }) => request<WorkerCallAudit>(`/api/worker-calls/${encodeURIComponent(item.id)}`, { signal }),
    enabled: open && Boolean(userId) && item.has_details,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const own = ownWorkerCall(item, userId)
  const statusLabel = { queued: t.workerQueued, delivered: t.workerDelivered, cancelled: t.workerCancelled, completed: t.workerCompleted, failed: t.workerFailed }[item.status]
  return <tr className="align-top">
    <td className="px-3 py-3"><code>{item.name}</code><p className="mt-1 text-xs text-muted-foreground">{item.id}</p></td>
    <td className="px-3 py-3"><p>{item.worker_label ?? item.worker_id}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{item.worker_id}</p></td>
    <td className="max-w-64 px-3 py-3">
      {own ? <><Link className="hover:underline" to={`/threads/${encodeURIComponent(item.thread_id)}`}>{item.thread_title || item.thread_id}</Link><p className="mt-1 font-mono text-xs text-muted-foreground">input #{item.input_record_id ?? "—"}</p></> : <><p className="text-xs text-muted-foreground">{t.caller}</p><code className="break-all text-xs">{item.caller_user_id}</code><p className="mt-1 text-xs text-muted-foreground">{t.privateThread}</p></>}
    </td>
    <td className="px-3 py-3"><Badge variant={item.status === "failed" ? "destructive" : item.status === "completed" ? "outline" : "secondary"}>{statusLabel}</Badge>{item.error && <p className="mt-2 max-w-64 break-words text-xs text-destructive">{item.error}</p>}</td>
    <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.created_at)}{item.completed_at && <><br />{formattedTime(language, item.completed_at)}</>}</td>
    <td className="max-w-80 px-3 py-3">
      {item.has_details ? <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-xs">{t.details}</summary>
        {open && <div className="mt-3 flex flex-col gap-2">
          {detail.isPending && <p role="status" className="text-xs text-muted-foreground">{t.loading}</p>}
          {detail.error && <Alert variant="destructive"><AlertDescription>{detail.error.message}<Button size="sm" variant="outline" onClick={() => void detail.refetch()}>{t.retry}</Button></AlertDescription></Alert>}
          {detail.data && <><Button className="self-start" size="sm" variant="outline" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{t.refresh}</Button>{([[t.workerArguments, detail.data.arguments], [t.workerResult, detail.data.result], [t.resource, detail.data.worker_resource]] as const).map(([label, value]) => <div key={label}><p className="text-xs font-medium">{label}</p><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{value === null ? "—" : JSON.stringify(value, null, 2)}</pre></div>)}</>}
        </div>}
      </details> : <p className="text-xs text-muted-foreground">{t.unavailable}</p>}
    </td>
  </tr>
}
