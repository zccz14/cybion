import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { FileTextIcon, RefreshCwIcon, SparklesIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { formattedTime } from "@/lib/time"
import { evidencePath, reportAuditPath, type DailyReport, type ReportJob, type ReportRequest, type ReportSummary, type ReportThread, type SummaryState } from "@/lib/daily-reports"

type Language = "en" | "zh"
const copy = {
  zh: {
    title: "日报", description: "先生成各 Thread 的日摘要，再按事项汇总日报。每项结论可追溯到原始记录。",
    scope: "UTC 自然日 · 日报素材仅含工作 Thread，排除报告 Thread；活动日历仍统计全部 Thread。今天的结果可能需要更新。",
    generate: "生成 / 更新日报", threadGenerate: "生成 / 更新日摘要", refresh: "刷新", retry: "重试", loading: "正在读取日报…",
    empty: "这一天没有活跃 Thread。", pick: "点击日历中的日期查看日报。", failure: "报表请求失败",
    setup: "请先在个人设置中选择默认上游和模型。", config: "个人设置",
    billing: "由报告 Thread 的模型执行，可能产生 Token 费用；首次创建沿用个人默认设置。正文可复用，但维护对话仍可能调用模型。打开页面或创建空报告 Thread 不会推理。",
    progress: "生成进度", composing: "正在汇总日报", threadPhase: "正在生成 Thread 日摘要", busy: "另一个日期的报表正在生成",
    completedJob: "本次生成已结束。请留意摘要是否因新活动而需要更新。", failedJob: "生成未完成，已成功的摘要会保留。",
    active: "活跃工作 Thread", records: "活动记录", inputs: "用户输入", requests: "推理请求", tokens: "Token",
    metrics: "以下数字仅统计工作 Thread。报表推理与压缩费用记在报告 Thread，纳入账户总用量和推理审计，不挂回源 Thread。",
    daily: "今日概览", thread: "Thread 日摘要", notGenerated: "尚未生成", stale: "需要更新", saved: "已保存", running: "生成中", failed: "失败",
    evidence: "原始记录", noItems: "无可提取的有据事项。", caveat: "AI 归纳，请核对原始证据。引用表示来源，不代表结论已经人工确认。",
    metadata: "版本与来源", version: "摘要版本", prompt: "提示词版本", model: "生成模型", generated: "生成时间", fingerprint: "来源指纹",
    range: "来源记录", background: "背景输入（不计入当日成果）", children: "依据的 Thread 摘要版本", raw: "查看来源清单",
    usage: "摘要生成用量", partialUsage: "部分请求未上报用量", latestInput: "最近输入摘录（不是 AI 摘要）",
    goals: "当日目标", results: "进展与结果", decisions: "重要决策", next: "未完成事项与下一步", completed: "今日完成", ongoing: "进行中事项", blocked: "阻塞与待办",
    reportThread: "报告 Thread", openThread: "打开报告 Thread", createThread: "创建报告 Thread", audit: "查看推理审计", stop: "停止", resume: "继续", jobUsage: "本任务用量", writerUsage: "写入此版本的模型请求", writerHint: "此处仅为写入请求的用量；完整读取、压缩与重试费用见任务和推理审计。", legacy: "历史独立生成版本（未接入 Thread 审计）", deletedAudit: "生成审计已删除，用量不可用",
    previous: "保留的上一次成功摘要", inspect: "查看摘要版本", close: "关闭版本详情",
  },
  en: {
    title: "Daily report", description: "Generate daily Thread summaries, then combine them by topic. Every statement links to its source records.",
    scope: "UTC calendar day · Reports cover work Threads, excluding the report Thread. The activity calendar still counts all Threads. Today remains provisional.",
    generate: "Generate / update report", threadGenerate: "Generate / update summary", refresh: "Refresh", retry: "Retry", loading: "Loading daily report…",
    empty: "No active Threads on this day.", pick: "Select a calendar day to inspect its report.", failure: "Report request failed",
    setup: "Select a default upstream and model in Personal settings first.", config: "Personal settings",
    billing: "Runs with the report Thread’s model and may incur token charges. Initial settings follow your personal defaults. Saved content can be reused; the maintenance conversation may still call the model. Page load and creating an empty report Thread never infer.",
    progress: "Progress", composing: "Composing daily report", threadPhase: "Summarizing Threads", busy: "A report for another date is generating",
    completedJob: "Generation finished. Check whether new activity has made a summary stale.", failedJob: "Generation incomplete. Successful summaries are retained.",
    active: "Active work Threads", records: "Activity records", inputs: "Inputs", requests: "Reasoning requests", tokens: "Tokens",
    metrics: "These database metrics cover work Threads only. Report inference and compaction are charged to the report Thread and included in account usage and reasoning audits, never the source Thread.",
    daily: "Day overview", thread: "Thread daily summary", notGenerated: "Not generated", stale: "Needs update", saved: "Saved", running: "Generating", failed: "Failed",
    evidence: "Source records", noItems: "No evidenced items extracted.", caveat: "AI-generated; verify against original evidence. Citations establish provenance, not human confirmation.",
    metadata: "Version & sources", version: "Summary version", prompt: "Prompt version", model: "Generation model", generated: "Generated", fingerprint: "Source fingerprint",
    range: "Source records", background: "Background input (not today's outcome)", children: "Source Thread summary versions", raw: "Inspect source manifest",
    usage: "Summary generation usage", partialUsage: "Some requests did not report usage", latestInput: "Latest input excerpt (not an AI summary)",
    goals: "Daily goal", results: "Progress & outcomes", decisions: "Key decisions", next: "Open work & next steps", completed: "Completed today", ongoing: "In progress", blocked: "Blockers & next steps",
    reportThread: "Report Thread", openThread: "Open report Thread", createThread: "Create report Thread", audit: "View reasoning audits", stop: "Stop", resume: "Continue", jobUsage: "Task usage", writerUsage: "Model request that wrote this version", writerHint: "Only the writing request is shown here. Full reading, compaction and retry usage belongs to the task and reasoning audits.", legacy: "Legacy standalone version (not Thread-audited)", deletedAudit: "Generation audit deleted; usage unavailable",
    previous: "Previous successful summary retained", inspect: "Inspect summary version", close: "Close version details",
  },
}

function Failure({ error, retry, language }: { error: Error; retry?: () => void; language: Language }) {
  const t = copy[language]
  return <Alert variant="destructive"><AlertTitle>{t.failure}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2"><span className="break-words">{error.message}</span>{retry && <Button variant="outline" size="sm" onClick={retry}>{t.retry}</Button>}</AlertDescription></Alert>
}

export function DailyReports({ date, language, sessionId, request }: { date: string | null; language: Language; sessionId: string; request: ReportRequest }) {
  const t = copy[language]
  const client = useQueryClient()
  const queryKey = ["daily-report", sessionId, date]
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => request<DailyReport>(`/api/reports/daily?date=${encodeURIComponent(date!)}`, { signal }),
    enabled: date !== null,
    refetchInterval: (query) => query.state.data?.generation.running_job || query.state.data?.generation.report_thread?.status === "running" ? 3000 : 30000,
  })
  const generate = useMutation({
    mutationKey: ["report-generate", sessionId, date],
    mutationFn: (threadId: string | null) => request<ReportJob>(`/api/reports/daily/${encodeURIComponent(date!)}/generate`, { method: "POST", body: JSON.stringify({ thread_id: threadId, language }) }),
    retry: false,
    onSuccess: (job) => {
      void client.invalidateQueries({ queryKey: ["threads"] })
      client.setQueryData<DailyReport>(queryKey, (current) => current ? { ...current, generation: { ...current.generation, job, running_job: job.status === "running" ? job : null } } : current)
      return client.invalidateQueries({ queryKey })
    },
  })
  const ensureThread = useMutation({
    mutationKey: ["report-thread-create", sessionId],
    mutationFn: () => request<ReportThread>("/api/reports/thread", { method: "POST" }),
    onSuccess: (thread) => {
      client.setQueryData<DailyReport>(queryKey, (current) => current ? { ...current, generation: { ...current.generation, report_thread: thread } } : current)
      void client.invalidateQueries({ queryKey: ["threads"] })
      return client.invalidateQueries({ queryKey })
    },
  })
  const control = useMutation({
    mutationKey: ["report-thread-control", sessionId, date],
    mutationFn: (action: "cancel" | "continue") => request(`/api/threads/${encodeURIComponent(query.data!.generation.report_thread!.id)}/${action}`, { method: "POST" }),
    retry: false,
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["threads"] }); return client.invalidateQueries({ queryKey }) },
  })
  if (!date) return <Card><CardHeader><CardTitle>{t.title}</CardTitle></CardHeader><CardContent>{t.pick}</CardContent></Card>
  const data = query.data
  const reportThread = data?.generation.report_thread
  const disabled = generate.isPending || control.isPending || Boolean(data?.generation.running_job) || reportThread?.status === "running" || !data?.generation.generator
  const number = (value: number) => value.toLocaleString(language)
  return <Card data-slot="daily-report">
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="flex items-center gap-2"><FileTextIcon className="size-4" />{t.title} · {date}</CardTitle><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCwIcon />{t.refresh}</Button><Button size="sm" disabled={disabled || !data?.active_thread_count} onClick={() => generate.mutate(null)}><SparklesIcon />{t.generate}</Button></div></div>
      <CardDescription>{t.description}</CardDescription><p className="text-xs text-muted-foreground">{t.scope}</p>
    </CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-5">
      <p className="text-xs leading-5 text-muted-foreground">{t.billing} {data?.generation.generator && <strong className="break-all font-medium">{data.generation.generator.upstream_name} · {data.generation.generator.model}</strong>}</p>
      {query.isLoading && <p role="status" className="flex items-center gap-2"><Spinner />{t.loading}</p>}
      {query.error && <Failure error={query.error} language={language} retry={() => void query.refetch()} />}
      {generate.error && <Failure error={generate.error} language={language} />}
      {ensureThread.error && <Failure error={ensureThread.error} language={language} />}
      {control.error && <Failure error={control.error} language={language} />}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {reportThread ? <><Link className="font-medium underline underline-offset-4" to={`/threads/${reportThread.id}`}>{t.openThread}</Link><Link className="text-xs underline" to={reportAuditPath(reportThread.id)}>{t.audit}</Link>{reportThread.status === "running" ? <Button size="sm" variant="outline" disabled={control.isPending} onClick={() => control.mutate("cancel")}>{t.stop}</Button> : data?.generation.job?.status === "failed" && data.generation.resumable_job_id === data.generation.job.id && <Button size="sm" variant="outline" disabled={control.isPending || disabled} onClick={() => control.mutate("continue")}>{t.resume}</Button>}</> : <Button size="sm" variant="outline" disabled={ensureThread.isPending || !data?.generation.generator} onClick={() => ensureThread.mutate()}>{t.createThread}</Button>}
      </div>
      {data?.generation.job?.executor_thread_id && <p className="text-xs text-muted-foreground">{t.jobUsage}: {number(data.generation.job.requests)} requests · {number(data.generation.job.input_tokens)} in / {number(data.generation.job.output_tokens)} out{data.generation.job.missing_usage_requests > 0 && ` · ${t.partialUsage}: ${data.generation.job.missing_usage_requests}`}</p>}
      {data && <>
        {!data.generation.generator && <p className="text-sm">{t.setup} <Link className="underline" to="/configuration">{t.config}</Link></p>}
        {data.generation.running_job && <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"><Spinner />{data.generation.running_job.date !== date ? `${t.busy}: ${data.generation.running_job.date}` : data.generation.running_job.phase === "daily" ? t.composing : t.threadPhase}<span className="tabular-nums">{t.progress}: {data.generation.running_job.completed_threads}/{data.generation.running_job.total_threads}</span></div>}
        {data.generation.job?.status === "failed" && <Alert variant="destructive"><AlertTitle>{t.failedJob}</AlertTitle><AlertDescription className="break-words">{data.generation.job.error}</AlertDescription></Alert>}
        {data.generation.job?.status === "completed" && <p role="status" className="text-xs text-muted-foreground">{t.completedJob}</p>}
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">{[[t.active, data.active_thread_count], [t.records, data.activity_records], [t.inputs, data.input_records], [t.requests, data.requests], [t.tokens, data.total_tokens]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lg tabular-nums">{number(Number(value))}</dd></div>)}</dl>
        <p className="text-xs text-muted-foreground">{t.metrics}</p>
        {data.active_thread_count === 0 ? <p>{t.empty}</p> : <>
          <section aria-label={t.daily} className="rounded-lg border bg-muted/20 p-3 sm:p-4"><h3 className="mb-3 font-semibold">{t.daily}</h3><SummaryPanel state={data.summary} language={language} sessionId={sessionId} request={request} /></section>
          <div className="flex flex-col gap-5">{data.threads.map((thread) => <section key={thread.id} aria-label={`${t.thread}: ${thread.title}`} className="min-w-0 rounded-lg border p-3 sm:p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><Link className="break-words font-medium underline-offset-4 hover:underline" to={`/threads/${thread.id}`}>{thread.title || thread.id}</Link><p className="mt-1 text-xs tabular-nums text-muted-foreground">{number(thread.activity_count)} {t.records} · {number(thread.input_count)} {t.inputs} · {number(thread.total_tokens)} {t.tokens}</p></div><Button size="sm" variant="outline" disabled={disabled} onClick={() => generate.mutate(thread.id)}><SparklesIcon />{t.threadGenerate}</Button></div>
            <div className="mt-4"><SummaryPanel state={thread.daily_summary} language={language} sessionId={sessionId} request={request} /></div>
            {thread.summary && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">{t.latestInput}</summary><p className="mt-2 break-all">{thread.summary}</p></details>}
          </section>)}</div>
        </>}
      </>}
    </CardContent>
  </Card>
}

function SummaryPanel({ state, language, sessionId, request }: { state: SummaryState; language: Language; sessionId: string; request: ReportRequest }) {
  const t = copy[language]
  const latest = state.latest
  const saved = state.saved
  const status = latest?.status ?? "missing"
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><Badge variant={status === "failed" ? "destructive" : "outline"}>{status === "running" ? t.running : status === "failed" ? t.failed : saved ? t.saved : t.notGenerated}</Badge>{state.stale && <Badge variant="secondary">{t.stale}</Badge>}{saved && <span className="text-xs text-muted-foreground">#{saved.id} · {saved.model}</span>}</div>
    {latest?.error && <p role="alert" className="break-words text-sm text-destructive">{latest.error}</p>}
    {saved && <>
      {status === "failed" && <p className="text-xs text-muted-foreground">{t.previous}</p>}
      <SummaryContent summary={saved} language={language} sessionId={sessionId} request={request} />
    </>}
  </div>
}

function SummaryContent({ summary, language, sessionId, request }: { summary: ReportSummary; language: Language; sessionId: string; request: ReportRequest }) {
  const t = copy[language]
  const labels: Record<string, string> = { goal: t.goals, progress: t.results, decisions: t.decisions, next_steps: t.next, completed: t.completed, in_progress: t.ongoing, blocked: t.blocked }
  const records = summary.source_manifest.records
  return <>
    <div className="grid gap-4 lg:grid-cols-2">{summary.content?.sections.map((section) => <section key={section.key} className="min-w-0"><h4 className="mb-2 text-sm font-medium">{labels[section.key]}</h4>{section.items.length === 0 ? <p className="text-xs text-muted-foreground">{t.noItems}</p> : <ul className="space-y-2">{section.items.map((item, index) => <li key={index} className="text-sm leading-6"><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{item.text}</p><div className="flex flex-wrap gap-2 text-xs" aria-label={t.evidence}>{[...new Set(item.evidence)].map((id) => <Link key={id} to={evidencePath(id)} className="rounded-sm text-primary underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">#{id}</Link>)}</div></li>)}</ul>}</section>)}</div>
    <p className="text-xs text-muted-foreground">{t.caveat}</p>
    <details className="min-w-0 text-xs text-muted-foreground"><summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">{t.metadata}</summary>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {[[t.version, `#${summary.id}`], [t.prompt, summary.prompt_version], [t.model, `${summary.upstream_name} · ${summary.model}`], [t.generated, formattedTime(language, summary.finished_at)], [t.range, `${records.length} · #${records[0]?.id ?? "—"}–#${records.at(-1)?.id ?? "—"}`], [summary.execution_kind === "thread" ? t.writerUsage : t.usage, summary.execution_kind === "thread" && summary.audit_id === null ? t.deletedAudit : `${summary.requests} requests · ${summary.input_tokens.toLocaleString(language)} in / ${summary.output_tokens.toLocaleString(language)} out`]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd className="mt-0.5 break-all text-foreground">{value}</dd></div>)}
      </dl>
      {summary.execution_kind === "thread" ? <div className="mt-2 flex flex-wrap items-center gap-2"><p>{t.writerHint}</p>{summary.executor_thread_id && <><Link className="underline" to={`/threads/${summary.executor_thread_id}`}>{t.reportThread}</Link><Link className="underline" to={reportAuditPath(summary.executor_thread_id)}>{t.audit}{summary.audit_id && ` #${summary.audit_id}`}</Link></>}{summary.input_record_id && <Link className="underline" to={evidencePath(summary.input_record_id)}>input #{summary.input_record_id}</Link>}</div> : <p className="mt-2">{t.legacy}</p>}
      {summary.missing_usage_requests > 0 && <p className="mt-2">{t.partialUsage}: {summary.missing_usage_requests}</p>}
      {summary.source_manifest.background_input_id && <p className="mt-2">{t.background}: <Link to={evidencePath(summary.source_manifest.background_input_id)} className="underline">#{summary.source_manifest.background_input_id}</Link></p>}
      {summary.source_manifest.children.length > 0 && <div className="mt-3 flex flex-col gap-2"><p>{t.children}</p>{summary.source_manifest.children.map((child) => child.summary_id && <VersionInspector key={child.thread_id} id={child.summary_id} language={language} sessionId={sessionId} request={request} />)}</div>}
      <p className="mt-3 break-all">{t.fingerprint}: <code>{summary.source_fingerprint}</code></p>
      <ManifestDetails manifest={summary.source_manifest} label={t.raw} />
    </details>
  </>
}

function VersionInspector({ id, language, sessionId, request }: { id: number; language: Language; sessionId: string; request: ReportRequest }) {
  const [open, setOpen] = useState(false)
  const t = copy[language]
  const query = useQuery({ queryKey: ["report-version", sessionId, id], queryFn: ({ signal }) => request<ReportSummary>(`/api/reports/summaries/${id}`, { signal }), enabled: open })
  return <div><Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t.close : t.inspect} #{id}</Button>{open && <div className="mt-3 flex min-w-0 flex-col gap-3 rounded-md border p-3">{query.isLoading && <Spinner />}{query.error && <Failure error={query.error} language={language} retry={() => void query.refetch()} />}{query.data && <SummaryContent summary={query.data} language={language} sessionId={sessionId} request={request} />}</div>}</div>
}

function ManifestDetails({ manifest, label }: { manifest: ReportSummary["source_manifest"]; label: string }) {
  const [open, setOpen] = useState(false)
  return <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">{label}</summary>{open && <pre tabIndex={0} className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2">{JSON.stringify(manifest, null, 2)}</pre>}</details>
}
