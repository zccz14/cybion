import { useMemo, useState, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { CalendarDaysIcon, RefreshCwIcon } from "lucide-react"

import { accountMetricNotes } from "@/lib/account-metrics"
import { formatBytes } from "@/lib/format"
import { formattedTime, formatStatsDuration } from "@/lib/time"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"

type Language = "en" | "zh"

type Running = {
  total: number; kernel: number; inference: number; device: number; unattended: number; longest_seconds: number
}
/** One account's all-time row, exactly as the administrator's Users page reads it. */
type AccountMetrics = {
  requests: number; input_tokens: number; output_tokens: number; total_tokens: number
  cached_tokens: number; cache_hit_rate: number | null; history_records: number; threads: number; workers: number
  running: Running; sqlite_bytes: number; sqlite_main_bytes: number; sqlite_wal_bytes: number; sqlite_shm_bytes: number
}
type Traffic = {
  worker_received_bytes: number; worker_sent_bytes: number
  upstream_received_bytes: number; upstream_sent_bytes: number
}
type Account = { metrics: AccountMetrics; traffic: Traffic | null }
type InsightModel = {
  model: string
  reasoning_effort: string | null
  calls: number
  completed: number
  in_flight: number
  failed: number
  cancelled: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  cached_tokens: number
  cache_hit_rate: number | null
  input_output_ratio: number | null
  duration_seconds: number
  average_duration_seconds: number | null
}
type InsightWorkerItem = {
  worker_id: string
  worker_label: string
  calls: number
  read_bytes: number
  write_bytes: number
  duration_seconds: number
  average_duration_seconds: number | null
}
type InsightActiveDay = {
  date: string
  active_threads: number
  activity_records: number
  input_records: number
  requests: number
  total_tokens: number
}
type Insights = {
  range: "24h" | "7d" | "30d" | "all"
  generated_at: number | null
  backfilling: boolean
  activity: { timezone: string; days: InsightActiveDay[] }
  tokens: {
    completed_requests: number
    input_tokens: number
    output_tokens: number
    total_tokens: number
    cached_tokens: number
    cache_hit_rate: number | null
    input_output_ratio: number | null
  }
  requests: { total: number; completed: number; in_flight: number; failed: number; cancelled: number }
  by_model: InsightModel[]
  worker: { calls: number; read_bytes: number; write_bytes: number; duration_seconds: number; average_duration_seconds: number | null; by_worker: InsightWorkerItem[] }
  history: { total_records: number; payload_bytes: number; checkpoint_count: number; latest_record_at: number | null }
  dimensions: { models: string[]; request_kinds: string[] }
  account: Account
}

const copy = {
  zh: {
    title: "用量统计",
    pageLoading: "正在读取用量统计…",
    pageError: "无法读取用量统计",
    retry: "重试",
    statsRange: "时间范围", stats24h: "近 24 小时", stats7d: "近 7 天", stats30d: "近 30 天", statsAll: "全部时间",
    statsModel: "模型", statsAllModels: "全部模型", statsRequestKind: "请求类型", statsAllRequestKinds: "全部请求类型", statsClearFilters: "清除筛选",
    statsGenerated: "快照时间 {time}", statsBackfilling: "快照仍在回填历史，较早的数据会随巡检逐步补全。",
    statsTokenUsage: "Token 用量", statsCompletedRequests: "已完成请求", statsInputTokens: "输入 Token", statsOutputTokens: "输出 Token",
    statsTotalTokens: "总 Token", statsCachedTokens: "缓存输入", statsCacheRate: "缓存率", statsInputOutputRatio: "输入 / 输出",
    statsRequests: "请求结果", statsCalls: "调用次数", statsCompleted: "已完成", statsInFlight: "在途", statsFailed: "失败", statsCancelled: "已取消",
    statsByModel: "按模型", reasoningEffort: "推理强度",
    statsWorkerCalls: "Worker 调用", statsWorkerDescription: "Worker 调用从排队到返回结果：耗时、Worker 读取的参数与写回的结果。",
    statsReadBytes: "读取 Bytes", statsWriteBytes: "写入 Bytes", statsWorker: "Worker", statsNoWorkers: "当前范围没有 Worker 调用。",
    statsTotalDuration: "总耗时", statsAverageDuration: "平均耗时",
    statsHistory: "协议历史", statsHistoryRecords: "记录数", statsPayloadBytes: "负载字节", statsCheckpoints: "检查点", statsLatestRecord: "最近记录",
    statsDailyActivity: "每日活跃 Thread",
    statsDailyActivityDescription: "Thread 在某天至少产生一条非 checkpoint 协议记录时视为活跃。按 UTC 自然日统计，只计入所选范围内已封口的小时；不受模型和请求类型筛选影响。",
    statsActiveThreads: "活跃 Thread", statsActivityRecords: "活动记录", statsInputs: "输入",
    statsCalendarLegend: "少", statsCalendarLegendMore: "多", statsTimezone: "时区", statsNoData: "当前范围没有统计数据。",
    accountTitle: "账号累计",
    accountRequests: "推理请求", accountInput: "输入", accountOutput: "输出", accountCached: "缓存输入",
    accountHistory: "历史记录", accountThreads: "线程", accountRunning: "运行中",
    accountKernel: "内核", accountInference: "推理", accountDevice: "设备", accountUnattended: "待恢复", accountLongest: "最久",
    accountSqlite: "SQLite", accountWorkers: "Workers", accountWorkerTraffic: "Worker 流量", accountUpstreamTraffic: "上游流量",
    accountSent: "发送", accountReceived: "接收",
    definitions: "统计口径",
    definitionsScope: "账号累计是全量数字，不随上方的时间范围与筛选变化；其余区块按所选范围、模型和请求类型统计，来自后台巡检物化的快照。",
  },
  en: {
    title: "Usage statistics",
    pageLoading: "Loading usage statistics…",
    pageError: "Could not load usage statistics",
    retry: "Retry",
    statsRange: "Time range", stats24h: "Last 24 hours", stats7d: "Last 7 days", stats30d: "Last 30 days", statsAll: "All time",
    statsModel: "Model", statsAllModels: "All models", statsRequestKind: "Request type", statsAllRequestKinds: "All request types", statsClearFilters: "Clear filters",
    statsGenerated: "Snapshot {time}", statsBackfilling: "Snapshots are still backfilling history; older days fill in as the patrol proceeds.",
    statsTokenUsage: "Token usage", statsCompletedRequests: "Completed requests", statsInputTokens: "Input tokens", statsOutputTokens: "Output tokens",
    statsTotalTokens: "Total tokens", statsCachedTokens: "Cached input", statsCacheRate: "Cache rate", statsInputOutputRatio: "Input / output",
    statsRequests: "Request outcomes", statsCalls: "Calls", statsCompleted: "Completed", statsInFlight: "In flight", statsFailed: "Failed", statsCancelled: "Cancelled",
    statsByModel: "By model", reasoningEffort: "Reasoning effort",
    statsWorkerCalls: "Worker calls", statsWorkerDescription: "Worker calls from queue to result: duration, arguments read by the Worker, and results written back.",
    statsReadBytes: "Read bytes", statsWriteBytes: "Write bytes", statsWorker: "Worker", statsNoWorkers: "No Worker calls in this range.",
    statsTotalDuration: "Total duration", statsAverageDuration: "Avg duration",
    statsHistory: "Protocol history", statsHistoryRecords: "Records", statsPayloadBytes: "Payload bytes", statsCheckpoints: "Checkpoints", statsLatestRecord: "Latest record",
    statsDailyActivity: "Daily active Threads",
    statsDailyActivityDescription: "A Thread is active when it has at least one non-checkpoint protocol record. Calendar days use UTC over the closed hours inside the selected range; model and request filters do not apply.",
    statsActiveThreads: "Active Threads", statsActivityRecords: "Activity records", statsInputs: "Inputs",
    statsCalendarLegend: "Fewer", statsCalendarLegendMore: "More", statsTimezone: "Timezone", statsNoData: "No statistics for this range.",
    accountTitle: "Account totals",
    accountRequests: "Requests", accountInput: "Input", accountOutput: "Output", accountCached: "Cached input",
    accountHistory: "History", accountThreads: "Threads", accountRunning: "Running",
    accountKernel: "Kernel", accountInference: "Inference", accountDevice: "Device", accountUnattended: "unattended", accountLongest: "Longest",
    accountSqlite: "SQLite", accountWorkers: "Workers", accountWorkerTraffic: "Worker traffic", accountUpstreamTraffic: "Upstream traffic",
    accountSent: "Sent", accountReceived: "Received",
    definitions: "Metric definitions",
    definitionsScope: "Account totals are all-time and ignore the range and filters above; every other section follows the selected range, model and request type, served from snapshots the background patrol materializes.",
  },
} as const

function AccountMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return <div>
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd>
    {detail === undefined ? null : <dd className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">{detail}</dd>}
  </div>
}

function AccountCard({ account, language }: { account: Account; language: Language }) {
  const t = copy[language]
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  // The account block reports a ratio (0–1) where the range sections report a
  // percentage; both print as one percent figure.
  const rate = (value: number | null) => value === null
    ? "—"
    : `${(value * 100).toLocaleString(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 1 })}%`
  const duration = (value: number) => formatStatsDuration(value, language)
  const metrics = account.metrics
  const traffic = account.traffic
  const flow = (sent: number, received: number) => <span className="flex flex-col gap-0.5 text-base">
    <span aria-label={`${t.accountSent} ${formatBytes(sent)}`}>↑ {formatBytes(sent)}</span>
    <span aria-label={`${t.accountReceived} ${formatBytes(received)}`}>↓ {formatBytes(received)}</span>
  </span>
  return <Card data-slot="insight-account">
    <CardHeader><CardTitle>{t.accountTitle}</CardTitle></CardHeader>
    <CardContent>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <AccountMetric label={t.accountRequests} value={number(metrics.requests)} />
        <AccountMetric label={t.statsTotalTokens} value={number(metrics.total_tokens)} detail={<>
          <span>{t.accountInput} {number(metrics.input_tokens)}</span>
          <span>{t.accountOutput} {number(metrics.output_tokens)}</span>
        </>} />
        <AccountMetric label={t.statsCacheRate} value={rate(metrics.cache_hit_rate)} detail={<span>{t.accountCached} {number(metrics.cached_tokens)}</span>} />
        <AccountMetric label={t.accountHistory} value={number(metrics.history_records)} />
        <AccountMetric label={t.accountThreads} value={number(metrics.threads)} />
        <AccountMetric label={t.accountRunning} value={number(metrics.running.total)} detail={<>
          <span>{t.accountKernel} {number(metrics.running.kernel)} · {t.accountInference} {number(metrics.running.inference)} · {t.accountDevice} {number(metrics.running.device)}</span>
          {metrics.running.total > 0 && <span>{t.accountLongest} {duration(metrics.running.longest_seconds)}</span>}
          {metrics.running.unattended > 0 && <span role="status" className="text-destructive">⚠ {number(metrics.running.unattended)} {t.accountUnattended}</span>}
        </>} />
        <AccountMetric label={t.accountSqlite} value={formatBytes(metrics.sqlite_bytes)} detail={<span>DB {formatBytes(metrics.sqlite_main_bytes)} · WAL {formatBytes(metrics.sqlite_wal_bytes)} · SHM {formatBytes(metrics.sqlite_shm_bytes)}</span>} />
        <AccountMetric label={t.accountWorkers} value={number(metrics.workers)} />
        <AccountMetric label={t.accountWorkerTraffic} value={flow(traffic?.worker_sent_bytes ?? 0, traffic?.worker_received_bytes ?? 0)} />
        <AccountMetric label={t.accountUpstreamTraffic} value={flow(traffic?.upstream_sent_bytes ?? 0, traffic?.upstream_received_bytes ?? 0)} />
      </dl>
    </CardContent>
  </Card>
}

function DailyActivityCard({ days, timezone, language }: { days: InsightActiveDay[]; timezone: string; language: Language }) {
  const t = copy[language]
  const maxActiveThreads = Math.max(1, ...days.map((day) => day.active_threads))
  const calendar = useMemo(() => {
    if (days.length === 0) return [] as Array<{ date: string | null; day: InsightActiveDay | null }>
    const byDate = new Map(days.map((day) => [day.date, day]))
    const first = new Date(`${days[0].date}T00:00:00Z`)
    const last = new Date(`${days.at(-1)!.date}T00:00:00Z`)
    first.setUTCDate(first.getUTCDate() - first.getUTCDay())
    last.setUTCDate(last.getUTCDate() + (6 - last.getUTCDay()))
    const cells: Array<{ date: string | null; day: InsightActiveDay | null }> = []
    for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10)
      cells.push({ date: byDate.has(date) ? date : null, day: byDate.get(date) ?? null })
    }
    return cells
  }, [days])
  const dateLabel = (date: string) => new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`))
  const tone = (count: number) => {
    if (count === 0) return "bg-muted"
    const share = count / maxActiveThreads
    if (share <= 0.25) return "bg-primary/20"
    if (share <= 0.5) return "bg-primary/40"
    if (share <= 0.75) return "bg-primary/65"
    return "bg-primary"
  }
  const dayDescription = (day: InsightActiveDay) => `${dateLabel(day.date)} · ${day.active_threads} ${t.statsActiveThreads} · ${day.input_records} ${t.statsInputs}`
  return <Card>
    <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div><CardTitle className="flex items-center gap-2"><CalendarDaysIcon />{t.statsDailyActivity}</CardTitle><CardDescription>{t.statsDailyActivityDescription}</CardDescription></div>
      <Badge variant="outline">{t.statsTimezone}: {timezone}</Badge>
    </CardHeader>
    <CardContent>
      {days.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{t.statsNoData}</p> : <>
        <div className="overflow-x-auto pb-2" role="grid" aria-label={t.statsDailyActivity}>
          <div className="grid min-w-max grid-flow-col grid-rows-7 gap-1" style={{ gridAutoColumns: "0.8rem" }}>
            {calendar.map((cell, index) => cell.day && cell.date
              ? <span
                key={cell.date}
                role="gridcell"
                aria-label={dayDescription(cell.day)}
                title={dayDescription(cell.day)}
                className={`size-3.5 rounded-sm ${tone(cell.day.active_threads)}`}
              />
              : <span key={`blank-${index}`} aria-hidden="true" className="size-3.5" />)}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>{t.statsDailyActivity}</p>
          <div className="flex items-center gap-2" aria-label={t.statsDailyActivity}><span>{t.statsCalendarLegend}</span><span className="size-3 rounded-sm bg-muted" /><span className="size-3 rounded-sm bg-primary/20" /><span className="size-3 rounded-sm bg-primary/40" /><span className="size-3 rounded-sm bg-primary/65" /><span className="size-3 rounded-sm bg-primary" /><span>{t.statsCalendarLegendMore}</span></div>
        </div>
      </>}
    </CardContent>
  </Card>
}

export function InsightsView({ language, sessionId, request }: {
  language: Language
  sessionId: string | null | undefined
  request: <T,>(path: string, init?: RequestInit) => Promise<T>
}) {
  const t = copy[language]
  const notes = accountMetricNotes[language]
  const [range, setRange] = useState<Insights["range"]>("7d")
  const [model, setModel] = useState("all")
  const [requestKind, setRequestKind] = useState("all")
  const query = useQuery({
    queryKey: ["insights", sessionId, range, model, requestKind],
    queryFn: () => {
      const params = new URLSearchParams({ range })
      if (model !== "all") params.set("model", model)
      if (requestKind !== "all") params.set("request_kind", requestKind)
      return request<Insights>(`/api/insights?${params}`)
    },
    refetchInterval: 5000,
  })
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  const rate = (value: number | null) => value === null
    ? "—"
    : `${value.toLocaleString(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 1 })}%`
  const ratio = (value: number | null) => value === null
    ? "—"
    : `${value.toLocaleString(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 2 })}:1`
  const duration = (value: number) => formatStatsDuration(value, language)
  const clear = () => { setRange("7d"); setModel("all"); setRequestKind("all") }
  if (query.error) return <Alert variant="destructive">
    <AlertTitle>{t.pageError}</AlertTitle>
    <AlertDescription>{query.error.message}<Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t.retry}</Button></AlertDescription>
  </Alert>
  const data = query.data
  if (!data) return <Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t.pageLoading}</CardContent></Card>
  const tokenMetrics = [
    [t.statsCompletedRequests, number(data.tokens.completed_requests)],
    [t.statsInputTokens, number(data.tokens.input_tokens)],
    [t.statsOutputTokens, number(data.tokens.output_tokens)],
    [t.statsTotalTokens, number(data.tokens.total_tokens)],
    [t.statsCachedTokens, number(data.tokens.cached_tokens)],
    [t.statsCacheRate, rate(data.tokens.cache_hit_rate)],
    [t.statsInputOutputRatio, ratio(data.tokens.input_output_ratio)],
  ]
  const outcomes: { label: string; count: number; variant: "outline" | "secondary" | "destructive" }[] = [
    { label: t.statsCalls, count: data.requests.total, variant: "outline" },
    { label: t.statsCompleted, count: data.requests.completed, variant: "secondary" },
    { label: t.statsInFlight, count: data.requests.in_flight, variant: "secondary" },
    { label: t.statsFailed, count: data.requests.failed, variant: "destructive" },
    { label: t.statsCancelled, count: data.requests.cancelled, variant: "outline" },
  ]
  return <section className="flex min-w-0 flex-col gap-6" aria-label={t.title}>
    <AccountCard account={data.account} language={language} />
    <Card data-slot="insight-filters">
      <CardContent className="flex flex-wrap items-center gap-2 pt-6">
        <Select value={range} onValueChange={(value) => setRange(value as Insights["range"])}>
          <SelectTrigger aria-label={t.statsRange} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="24h">{t.stats24h}</SelectItem><SelectItem value="7d">{t.stats7d}</SelectItem><SelectItem value="30d">{t.stats30d}</SelectItem><SelectItem value="all">{t.statsAll}</SelectItem></SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger aria-label={t.statsModel} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t.statsAllModels}</SelectItem>{data.dimensions.models.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={requestKind} onValueChange={setRequestKind}>
          <SelectTrigger aria-label={t.statsRequestKind} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t.statsAllRequestKinds}</SelectItem>{data.dimensions.request_kinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={clear}><RefreshCwIcon data-icon="inline-start" />{t.statsClearFilters}</Button>
      </CardContent>
    </Card>
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{t.statsGenerated.replace("{time}", formattedTime(language, data.generated_at))}</p>
      {data.backfilling && <p className="text-xs text-muted-foreground">{t.statsBackfilling}</p>}
    </div>
    <DailyActivityCard days={data.activity.days} timezone={data.activity.timezone} language={language} />
    <Card>
      <CardHeader><CardTitle>{t.statsTokenUsage}</CardTitle><CardDescription>{t.statsByModel}</CardDescription></CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">{tokenMetrics.map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd></div>)}</dl>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t.statsByModel}</CardTitle><CardDescription>{number(data.requests.total)} {t.statsCalls}</CardDescription></CardHeader>
      <CardContent>
        {data.by_model.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{t.statsNoData}</p> : <div className="overflow-x-auto"><table className="w-full min-w-[78rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t.statsModel}</th><th className="px-3 py-2 font-medium">{t.reasoningEffort}</th><th className="px-3 py-2 font-medium">{t.statsCalls}</th><th className="px-3 py-2 font-medium">{t.statsInputTokens}</th><th className="px-3 py-2 font-medium">{t.statsOutputTokens}</th><th className="px-3 py-2 font-medium">{t.statsTotalTokens}</th><th className="px-3 py-2 font-medium">{t.statsCachedTokens}</th><th className="px-3 py-2 font-medium">{t.statsCacheRate}</th><th className="px-3 py-2 font-medium">{t.statsInputOutputRatio}</th><th className="px-3 py-2 font-medium">{t.statsAverageDuration}</th><th className="px-3 py-2 font-medium">{t.statsTotalDuration}</th></tr></thead><tbody className="divide-y">{data.by_model.map((item) => <tr key={JSON.stringify([item.model, item.reasoning_effort])} className="align-top"><td className="px-3 py-3"><code>{item.model}</code><p className="mt-1 text-xs text-muted-foreground">{number(item.completed)} {t.statsCompleted}</p></td><td className="px-3 py-3"><code>{item.reasoning_effort ?? "—"}</code></td><td className="px-3 py-3 font-mono tabular-nums">{number(item.calls)}<p className="mt-1 text-xs text-muted-foreground">{number(item.in_flight)} {t.statsInFlight}</p></td><td className="px-3 py-3 font-mono tabular-nums">{number(item.input_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.output_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.total_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.cached_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{rate(item.cache_hit_rate)}</td><td className="px-3 py-3 font-mono tabular-nums">{ratio(item.input_output_ratio)}</td><td className="px-3 py-3 font-mono tabular-nums">{item.average_duration_seconds === null ? "—" : duration(item.average_duration_seconds)}</td><td className="px-3 py-3 font-mono tabular-nums">{duration(item.duration_seconds)}</td></tr>)}</tbody></table></div>}
      </CardContent>
    </Card>
    {/* Request outcomes and Worker calls are two full-width rows: side by side
        they squeezed the Worker table below its readable width. */}
    <div className="grid gap-4">
      <Card data-slot="insight-requests"><CardHeader><CardTitle>{t.statsRequests}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{outcomes.map(({ label, count, variant }) => <div className="flex items-center justify-between rounded-lg border px-3 py-2" key={label}><Badge variant={variant}>{label}</Badge><span className="font-mono text-sm tabular-nums">{number(count)}</span></div>)}</CardContent></Card>
      <Card data-slot="insight-worker"><CardHeader><CardTitle>{t.statsWorkerCalls}</CardTitle><CardDescription>{t.statsWorkerDescription}</CardDescription></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t.statsCalls}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.worker.calls)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsTotalDuration}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{duration(data.worker.duration_seconds)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsAverageDuration}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{data.worker.average_duration_seconds === null ? "—" : duration(data.worker.average_duration_seconds)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsReadBytes}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.worker.read_bytes)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsWriteBytes}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.worker.write_bytes)}</dd></div></dl>{data.worker.by_worker.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">{t.statsNoWorkers}</p> : <div className="mt-6 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-2 py-2 font-medium">{t.statsWorker}</th><th className="px-2 py-2 font-medium">{t.statsCalls}</th><th className="px-2 py-2 font-medium">{t.statsTotalDuration}</th><th className="px-2 py-2 font-medium">{t.statsAverageDuration}</th><th className="px-2 py-2 font-medium">{t.statsReadBytes}</th><th className="px-2 py-2 font-medium">{t.statsWriteBytes}</th></tr></thead><tbody className="divide-y">{data.worker.by_worker.map((item) => <tr key={item.worker_id}><td className="px-2 py-2"><p>{item.worker_label}</p><code className="text-xs text-muted-foreground">{item.worker_id}</code></td><td className="px-2 py-2 font-mono tabular-nums">{number(item.calls)}</td><td className="px-2 py-2 font-mono tabular-nums">{duration(item.duration_seconds)}</td><td className="px-2 py-2 font-mono tabular-nums">{item.average_duration_seconds === null ? "—" : duration(item.average_duration_seconds)}</td><td className="px-2 py-2 font-mono tabular-nums">{formatBytes(item.read_bytes)}</td><td className="px-2 py-2 font-mono tabular-nums">{formatBytes(item.write_bytes)}</td></tr>)}</tbody></table></div>}</CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>{t.statsHistory}</CardTitle></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-xs text-muted-foreground">{t.statsHistoryRecords}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.history.total_records)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsPayloadBytes}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.history.payload_bytes)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsCheckpoints}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.history.checkpoint_count)}</dd></div><div><dt className="text-xs text-muted-foreground">{t.statsLatestRecord}</dt><dd className="mt-1 text-sm font-medium">{formattedTime(language, data.history.latest_record_at)}</dd></div></dl></CardContent></Card>
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">{t.definitions}</summary>
      <div className="mt-2 flex max-w-3xl flex-col gap-2">
        <p>{t.definitionsScope}</p>
        <p>{notes.usageNote}</p>
        <p>{notes.runningNote}</p>
        <p>{notes.networkNote}</p>
        <p>{notes.sqliteNote}</p>
        <p>{notes.workersNote}</p>
      </div>
    </details>
  </section>
}
