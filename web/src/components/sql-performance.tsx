import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { RefreshCwIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { cn, errorMessage } from "@/lib/utils"
import { formatLatency, formatTotalDuration } from "@/lib/route-performance"
import {
  callerLabel,
  callerSource,
  formatPercent,
  formatScanPerCall,
  formatShare,
  hotShare,
  hotStatements,
  scanSeverity,
  sortStatements,
  statementShare,
  sqlPerformanceWindows,
  sqlPreview,
  sqlSeriesPeak,
  summarizeStatementSources,
  type SqlBucket,
  type SqlCallerSource,
  type SqlPerformance,
  type SqlPerformanceWindow,
  type SqlSortKey,
  type SqlStatement,
} from "@/lib/sql-performance"
import { formattedTime } from "@/lib/time"

const copy = {
  en: {
    title: "SQL performance",
    description: "Every statement these databases run, timed inside SQLite with the rows it scanned. The connection serving one account is a single queue, so one statement that walks a table holds up every request behind it. Only an administrator reads this page: a statement is not attributable to one account.",
    required: "Only an administrator reads SQL performance.",
    window: "Window",
    hours1: "Last hour",
    hours6: "Last 6 hours",
    hours24: "Last 24 hours",
    days7: "Last 7 days",
    perMinute: "per minute",
    perHour: "per hour",
    unitMinute: "minute",
    unitHour: "hour",
    refresh: "Refresh",
    generated: "Read at {time}",
    coverage: "Newest bucket {time}",
    profiling: "Profiling",
    profilingOn: "Recording",
    profilingOff: "Paused",
    profilingHint: "Turning it off stops recording without a release; the counters already taken stay.",
    statementsTitle: "Statements",
    totalTitle: "Total time",
    scanTitle: "Rows scanned",
    slowTitle: "Slow statements",
    slowScope: "Statements at or above 100 ms",
    average: "Average",
    p50: "P50",
    p95: "P95",
    p99: "P99",
    max: "Max",
    volume: "Statements",
    volumeDescription: "Statements run each {unit} of the window",
    trend: "P95 latency",
    trendDescription: "The 95th percentile of statement time each {unit}",
    hotspots: "Where the time goes",
    hotspotsDescription: "The statements that own this window, largest cumulative time first. The bar is that statement's share of all statement time, so the longest bar is what holds the queue.",
    hotspotTop: "These {count} account for {share} of the {total} recorded.",
    hotspotLanes: "By lane",
    share: "Share",
    table: "By statement",
    tableDescription: "Ordered by cumulative time: a statement that costs 18 ms every five seconds outranks one that costs 400 ms once. Click a column to sort.",
    tableCount: "{shown} of {total} statements shown",
    statement: "Statement",
    calls: "Calls",
    callsSuffix: "calls",
    total: "Total",
    scanPerCall: "Scan/call",
    slowStatements: "Slow",
    empty: "No statement has been recorded in this window yet.",
    slowSamples: "Slowest statements",
    slowSamplesDescription: "The twenty slowest single statements kept from the last 500 recorded",
    slowEmpty: "Nothing at or above 100 ms in this window.",
    sampledAt: "Time",
    duration: "Duration",
    rows: "Rows",
    loading: "Loading SQL performance…",
    retry: "Retry",
    loadError: "Could not read SQL performance",
    sortBy: "Sort by {column}",
    overhead: "What this measurement costs",
    overheadDescription: "The profiler runs on the thread that owns the connection, so its own cost lands in the same queue it measures. One statement in 256 is timed end to end and the average is scaled back up.",
    overheadShare: "Share of wall time",
    overheadWorst: "Worst interval",
    overheadRecorder: "Recorder time",
    overheadMeasured: "Statements measured",
    overheadUnattributed: "Lost samples",
    overheadHealthy: "Well below the work it finds.",
    overheadLost: "A non-zero count means the fixed table was full and those statements went unrecorded.",
    scanNone: "indexed",
    scanSome: "small scan",
    scanWide: "wide scan",
    scanFull: "table scan",
    scanHint: "Full-scan steps per call. One means a point lookup; thousands mean the statement walks more rows than it returns.",
    sourceBrowser: "browser",
    sourceWorker: "worker",
    sourceIntegration: "integration",
    sourcePatrol: "patrol",
    peak: "Peak {value}",
  },
  zh: {
    title: "SQL 性能",
    description: "这些数据库执行的每一条语句，在 SQLite 内部计量，连同它扫过的行数。一个账号只有一个连接、一条队列，所以一条走全表的语句会把它后面所有请求一起按住。这个页面仅管理员可见：语句无法归属到某个账号。",
    required: "SQL 性能仅管理员可见。",
    window: "时间范围",
    hours1: "最近 1 小时",
    hours6: "最近 6 小时",
    hours24: "最近 24 小时",
    days7: "最近 7 天",
    perMinute: "每分钟",
    perHour: "每小时",
    unitMinute: "分钟",
    unitHour: "小时",
    refresh: "刷新",
    generated: "读取于 {time}",
    coverage: "最新分桶 {time}",
    profiling: "采集",
    profilingOn: "记录中",
    profilingOff: "已暂停",
    profilingHint: "关掉即停止记录，不用发版；已经计下的数据保留。",
    statementsTitle: "语句数",
    totalTitle: "累计耗时",
    scanTitle: "扫描行数",
    slowTitle: "慢语句",
    slowScope: "耗时 ≥ 100 毫秒的语句",
    average: "平均",
    p50: "P50",
    p95: "P95",
    p99: "P99",
    max: "最大",
    volume: "语句量",
    volumeDescription: "区间内每{unit}执行的语句数",
    trend: "P95 延迟",
    trendDescription: "每{unit}语句耗时的 95 分位",
    hotspots: "时间花在哪",
    hotspotsDescription: "这个区间里最占时间的语句，按累计耗时从大到小。条形是它占全部语句耗时的比例——最长的那条，就是按住队列的地方。",
    hotspotTop: "这 {count} 条占全部耗时的 {share}，合计 {total}。",
    hotspotLanes: "按来源",
    share: "占比",
    table: "按语句",
    tableDescription: "按累计耗时排序：每五秒跑一次、每次 18 毫秒的语句，排在只跑过一次的 400 毫秒语句前面。点击列头可改排序。",
    tableCount: "共 {total} 条，显示 {shown} 条",
    statement: "语句",
    calls: "次数",
    callsSuffix: "次",
    total: "累计",
    scanPerCall: "扫描/次",
    slowStatements: "慢",
    empty: "这个区间还没有记录到语句。",
    slowSamples: "最慢的语句",
    slowSamplesDescription: "从最近 500 条记录里保留的最慢二十条单次执行",
    slowEmpty: "这个区间没有 ≥ 100 毫秒的语句。",
    sampledAt: "时间",
    duration: "耗时",
    rows: "扫描行",
    loading: "正在读取 SQL 性能…",
    retry: "重试",
    loadError: "读取 SQL 性能失败",
    sortBy: "按{column}排序",
    overhead: "这个测量本身花多少",
    overheadDescription: "采集器跑在持有连接的那个线程上，所以它自己的开销也落在它要测量的那条队列里。每 256 条语句端到端计时一次，再按总量外推。",
    overheadShare: "占墙钟比例",
    overheadWorst: "最差区间",
    overheadRecorder: "采集耗时",
    overheadMeasured: "已计时语句",
    overheadUnattributed: "丢失样本",
    overheadHealthy: "远低于它找出来的工作量。",
    overheadLost: "非零表示固定槽位表已满，那些语句没有被记录。",
    scanNone: "走索引",
    scanSome: "小扫描",
    scanWide: "大范围扫",
    scanFull: "全表扫",
    scanHint: "每次执行的表扫描步数。1 表示点查，上千表示这条语句走过的行远多于它返回的行。",
    sourceBrowser: "浏览器",
    sourceWorker: "设备",
    sourceIntegration: "集成",
    sourcePatrol: "巡逻",
    peak: "峰值 {value}",
  },
} as const

const windowLabels = { "1h": "hours1", "6h": "hours6", "24h": "hours24", "7d": "days7" } as const

type SqlColumn = { key: SqlSortKey | null; label: keyof typeof copy.en; numeric?: boolean; narrow?: string }

const columns: SqlColumn[] = [
  { key: null, label: "statement" },
  { key: "statements", label: "calls", numeric: true },
  { key: "total_us", label: "total", numeric: true },
  // Share is proportional to Total, so sorting by it would be the same click.
  { key: null, label: "share", numeric: true },
  { key: "fullscan_per_call", label: "scanPerCall", numeric: true },
  { key: "average_us", label: "average", numeric: true },
  { key: "p95_us", label: "p95", numeric: true, narrow: "hidden md:table-cell" },
  { key: "max_us", label: "max", numeric: true },
  { key: "slow_statements", label: "slowStatements", numeric: true, narrow: "hidden lg:table-cell" },
]

type Props = {
  language: "en" | "zh"
  sessionId: string | null | undefined
  request: <T>(path: string, init?: RequestInit) => Promise<T>
  /** The audit is cross-tenant, so the page says so instead of firing a query
   * the server will refuse when a non-administrator reaches it by URL. */
  allowed: boolean
}

export function SqlPerformance({ language, sessionId, request, allowed }: Props) {
  return <SqlPerformanceSession key={sessionId} language={language} sessionId={sessionId} request={request} allowed={allowed} />
}

function SqlPerformanceSession({ language, sessionId, request, allowed }: Props) {
  const t = copy[language]
  const [window, setWindow] = useState<SqlPerformanceWindow>("24h")
  const [sortKey, setSortKey] = useState<SqlSortKey>("total_us")
  const [descending, setDescending] = useState(true)
  const query = useQuery({
    queryKey: ["sql-performance", sessionId, window],
    queryFn: ({ signal }) => request<SqlPerformance>(`/api/sql-performance?window=${window}`, { signal }),
    enabled: allowed,
    refetchInterval: 10_000,
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => request<{ enabled: boolean }>("/api/sql-performance", { method: "POST", body: JSON.stringify({ enabled }) }),
    onSuccess: () => void query.refetch(),
  })
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  const sort = (key: SqlSortKey) => {
    if (key === sortKey) setDescending(!descending)
    else {
      setSortKey(key)
      setDescending(true)
    }
  }
  const statements = useMemo(
    () => (query.data ? sortStatements(query.data.statements, sortKey, descending) : []),
    [query.data, sortKey, descending],
  )
  if (!allowed) return <p className="text-sm text-muted-foreground">{t.required}</p>
  if (query.error) {
    return <Alert variant="destructive">
      <AlertTitle>{t.loadError}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span className="break-words">{errorMessage(query.error)}</span>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t.retry}</Button>
      </AlertDescription>
    </Alert>
  }
  if (!query.data) {
    return <Card><CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground"><Spinner />{t.loading}</CardContent></Card>
  }
  const data = query.data
  const unit = data.resolution === "minute" ? t.perMinute : t.perHour
  const unitWord = data.resolution === "minute" ? t.unitMinute : t.unitHour
  const withUnit = (text: string) => text.replace("{unit}", unitWord)
  const totals = data.totals
  const metrics = [
    [t.statementsTitle, number(totals.statements)],
    [t.totalTitle, formatTotalDuration(totals.total_us, language)],
    [t.scanTitle, number(totals.fullscan_steps)],
    [t.slowTitle, number(totals.slow_statements)],
    [t.average, formatLatency(totals.average_us)],
    [t.p50, formatLatency(totals.p50_us)],
    [t.p95, formatLatency(totals.p95_us)],
    [t.p99, formatLatency(totals.p99_us)],
    [t.max, formatLatency(totals.max_us)],
  ]
  const overhead = data.overhead
  return <div className="flex flex-col gap-6">
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 pt-6">
        <Select value={window} onValueChange={(value) => setWindow(value as SqlPerformanceWindow)}>
          <SelectTrigger aria-label={t.window} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {sqlPerformanceWindows.map((option) => <SelectItem key={option} value={option}>{t[windowLabels[option]]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Badge variant="outline">{unit}</Badge>
        <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
          <RefreshCwIcon data-icon="inline-start" />{t.refresh}
        </Button>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" data-slot="sql-performance-profiling">
          <span id="sql-profiling-label">{t.profiling}</span>
          <Switch
            aria-labelledby="sql-profiling-label"
            aria-describedby="sql-profiling-hint"
            checked={data.enabled}
            disabled={toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate(enabled)}
          />
          <span className="tabular-nums">{data.enabled ? t.profilingOn : t.profilingOff}</span>
        </span>
        <span className="text-xs text-muted-foreground" data-slot="sql-performance-freshness">
          {t.generated.replace("{time}", formattedTime(language, data.generated_at))}
          {data.latest_bucket_start === null ? "" : ` · ${t.coverage.replace("{time}", formattedTime(language, data.latest_bucket_start))}`}
        </span>
        <p id="sql-profiling-hint" className="sr-only">{t.profilingHint}</p>
      </CardContent>
    </Card>
    <Card>
      <CardContent className="pt-6">
        <dl className="grid grid-cols-3 gap-x-6 gap-y-4 lg:grid-cols-9" data-slot="sql-performance-totals">
          {metrics.map(([label, value]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd>
          </div>)}
        </dl>
      </CardContent>
    </Card>
    <Hotspots statements={data.statements} totalUs={totals.total_us} t={t} number={number} language={language} />
    <Card>
      <CardHeader>
        <CardTitle>{t.overhead}</CardTitle>
        <CardDescription>{t.overheadDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4" data-slot="sql-performance-overhead">
          <div>
            <dt className="text-xs text-muted-foreground">{t.overheadShare}</dt>
            <dd className={cn("mt-1 font-mono text-lg font-medium tabular-nums", overhead.share_ppm > 10_000 && "text-destructive")}>{formatShare(overhead.share_ppm)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.overheadWorst}</dt>
            <dd className={cn("mt-1 font-mono text-lg font-medium tabular-nums", overhead.worst_ppm > 10_000 && "text-destructive")}>{formatShare(overhead.worst_ppm)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.overheadRecorder}</dt>
            <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatTotalDuration(overhead.recorder_us, language)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.overheadMeasured}</dt>
            <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(overhead.timed_statements)} / {number(overhead.statements)}</dd>
          </div>
        </dl>
        <p className={cn("mt-4 border-t pt-4 text-xs text-muted-foreground", overhead.unattributed > 0 && "text-destructive")}>
          {overhead.unattributed > 0 ? `${t.overheadLost} (${number(overhead.unattributed)})` : t.overheadHealthy}
        </p>
      </CardContent>
    </Card>
    <section className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t.volume}</CardTitle>
          <CardDescription>{withUnit(t.volumeDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatementVolume series={data.series} peakLabel={t.peak.replace("{value}", number(sqlSeriesPeak(data.series)))} empty={t.empty} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.trend}</CardTitle>
          <CardDescription>{withUnit(t.trendDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatementTrend series={data.series} peakLabel={t.peak.replace("{value}", formatLatency(sqlSeriesPeak(data.series, "p95_us")))} empty={t.empty} />
        </CardContent>
      </Card>
    </section>
    <Card>
      <CardHeader>
        <CardTitle>{t.table}</CardTitle>
        <CardDescription>{t.tableDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        {statements.length === 0
          ? <p className="py-6 text-sm text-muted-foreground">{t.empty}</p>
          : <div className="max-h-[36rem] overflow-auto rounded-md border">
            <table className="w-full min-w-[58rem] text-left text-sm" data-slot="sql-performance-statements">
              <thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground shadow-[inset_0_-1px_0_var(--color-border)]">
                <tr>{columns.map((column) => <th key={column.label} aria-sort={column.key !== null && column.key === sortKey ? (descending ? "descending" : "ascending") : "none"} className={cn("px-3 py-2 font-medium", column.numeric && "text-right", column.narrow)}>
                  {column.key === null
                    ? t[column.label]
                    : <button type="button" aria-label={t.sortBy.replace("{column}", t[column.label])} onClick={() => sort(column.key!)} className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                      {t[column.label]}{column.key === sortKey ? <span aria-hidden="true">{descending ? "↓" : "↑"}</span> : null}
                    </button>}
                </th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {statements.map((statement) => <StatementRow key={statement.key} statement={statement} totalUs={totals.total_us} t={t} number={number} language={language} />)}
              </tbody>
            </table>
          </div>}
        {statements.length > 0 && <p className="mt-3 text-xs text-muted-foreground tabular-nums">{t.tableCount.replace("{shown}", number(statements.length)).replace("{total}", number(data.statements.length))}</p>}
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>{t.slowSamples}</CardTitle>
        <CardDescription>{t.slowSamplesDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.slow.length === 0
          ? <p className="py-6 text-sm text-muted-foreground">{t.slowEmpty}</p>
          : <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm" data-slot="sql-performance-slow">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t.sampledAt}</th>
                  <th className="px-3 py-2 font-medium">{t.statement}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.rows}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.duration}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.slow.map((sample) => <tr key={`${sample.sampled_at}-${sample.key}-${sample.latency_us}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formattedTime(language, sample.sampled_at)}</td>
                  <td className="max-w-[26rem] px-3 py-2"><StatementName sql={sample.sql} caller={sample.caller} t={t} /></td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{number(sample.fullscan_steps)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatLatency(sample.latency_us)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
      </CardContent>
    </Card>
  </div>
}

function Hotspots({ statements, totalUs, t, number, language }: {
  statements: SqlStatement[]
  totalUs: number
  t: typeof copy.en | typeof copy.zh
  number: (value: number) => string
  language: "en" | "zh"
}) {
  const top = hotStatements(statements, 3)
  if (top.length === 0) return null
  const lanes = summarizeStatementSources(statements, totalUs).slice(0, 4)
  return <Card>
    <CardHeader>
      <CardTitle>{t.hotspots}</CardTitle>
      <CardDescription>{t.hotspotsDescription}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3" data-slot="sql-performance-hotspots">
        {top.map((statement, index) => {
          const share = statementShare(statement, totalUs)
          return <li key={statement.key} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="w-3 shrink-0 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1"><StatementName sql={statement.sql} caller={statement.caller} t={t} /></span>
              <span className="flex w-full items-baseline justify-end gap-3 font-mono text-sm tabular-nums sm:ml-auto sm:w-auto">
                <span className="text-muted-foreground">{number(statement.statements)} {t.callsSuffix}</span>
                <span>{formatTotalDuration(statement.total_us, language)}</span>
                <span className="w-12 text-right font-medium">{formatPercent(share)}</span>
              </span>
            </div>
            <div className="ml-6 flex h-2 overflow-hidden rounded-full bg-muted" title={formatPercent(share)}>
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(1, share * 100)}%` }} />
            </div>
          </li>
        })}
      </ol>
      <div className="flex flex-col gap-2 border-t pt-4">
        <p className="text-xs text-muted-foreground tabular-nums">
          {t.hotspotTop.replace("{count}", number(top.length)).replace("{share}", formatPercent(hotShare(top, totalUs))).replace("{total}", formatTotalDuration(totalUs, language))}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs" data-slot="sql-performance-hotspot-lanes">
          <span className="text-muted-foreground">{t.hotspotLanes}</span>
          {lanes.map((lane) => <Badge key={lane.source} variant="outline" className="font-normal">
            {sourceLabel(lane.source, t)} <span className="ml-1 font-mono tabular-nums">{formatPercent(lane.share)}</span>
          </Badge>)}
        </div>
      </div>
    </CardContent>
  </Card>
}

function StatementRow({ statement, totalUs, t, number, language }: {
  statement: SqlStatement
  totalUs: number
  t: typeof copy.en | typeof copy.zh
  number: (value: number) => string
  language: "en" | "zh"
}) {
  const severity = scanSeverity(statement.fullscan_per_call)
  const value = (label: SqlColumn["label"]) => {
    switch (label) {
      case "calls":
        return number(statement.statements)
      case "total":
        return formatTotalDuration(statement.total_us, language)
      case "share": {
        const share = statementShare(statement, totalUs)
        return <span className="inline-flex items-center justify-end gap-2">
          <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} /></span>
          <span className="w-10 text-right">{formatPercent(share)}</span>
        </span>
      }
      case "scanPerCall":
        // The badge is a fixed-width slot after the number, so the counts line up
        // on their right edge even though the verdicts differ in width.
        return <span className="inline-flex items-center justify-end gap-2">
          <span>{formatScanPerCall(statement.fullscan_per_call, number)}</span>
          <span className="flex w-16 shrink-0 justify-start text-[10px]">
            {severity === "none"
              ? <span className="text-muted-foreground" title={t.scanHint}>{t.scanNone}</span>
              : <Badge variant={severity === "full" ? "destructive" : severity === "wide" ? "outline" : "secondary"} className="text-[10px]" title={t.scanHint}>{t[severity === "full" ? "scanFull" : severity === "wide" ? "scanWide" : "scanSome"]}</Badge>}
          </span>
        </span>
      case "average":
        return formatLatency(statement.average_us)
      case "p95":
        return formatLatency(statement.p95_us)
      case "max":
        return formatLatency(statement.max_us)
      case "slowStatements":
        return statement.slow_statements === 0 ? "—" : number(statement.slow_statements)
      default:
        return "—"
    }
  }
  return <tr data-slot="sql-performance-statement">
    {columns.map((column) => <td
      key={column.label}
      className={cn(
        "px-3 py-2 align-top",
        column.numeric && "text-right font-mono tabular-nums",
        column.narrow,
        column.label === "statement" && "w-[34%] max-w-0",
      )}
    >{column.label === "statement" ? <StatementName sql={statement.sql} caller={statement.caller} t={t} /> : value(column.label)}</td>)}
  </tr>
}

function StatementName({ sql, caller, t }: { sql: string; caller: string; t: typeof copy.en | typeof copy.zh }) {
  return <span className="flex min-w-0 flex-col gap-1">
    <span className="flex min-w-0 items-center gap-2">
      <Badge variant="outline" className="shrink-0 text-[10px]">{sourceLabel(callerSource(caller), t)}</Badge>
      <code className="truncate text-[11px] text-muted-foreground" title={caller}>{callerLabel(caller)}</code>
    </span>
    <code data-slot="sql-performance-statement-sql" className="truncate text-xs" title={sql}>{sqlPreview(sql)}</code>
  </span>
}

function sourceLabel(source: SqlCallerSource, t: typeof copy.en | typeof copy.zh) {
  if (source === "worker") return t.sourceWorker
  if (source === "integration") return t.sourceIntegration
  if (source === "patrol") return t.sourcePatrol
  return t.sourceBrowser
}

function StatementVolume({ series, peakLabel, empty }: { series: SqlBucket[]; peakLabel: string; empty: string }) {
  const peak = sqlSeriesPeak(series)
  if (series.length === 0) return <p className="py-10 text-sm text-muted-foreground">{empty}</p>
  return <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground tabular-nums">{peakLabel}</p>
    <div className="flex h-32 items-end gap-px" data-slot="sql-performance-volume">
      {series.map((bucket) => <div
        key={bucket.bucket_start}
        title={`${bucket.statements}`}
        className={`min-w-px flex-1 rounded-t-sm ${bucket.slow_statements > 0 ? "bg-destructive/80" : "bg-primary/70"}`}
        style={{ height: `${Math.max(2, (bucket.statements / peak) * 100)}%` }}
      />)}
    </div>
  </div>
}

function StatementTrend({ series, peakLabel, empty }: { series: SqlBucket[]; peakLabel: string; empty: string }) {
  const peak = sqlSeriesPeak(series, "p95_us")
  if (series.length === 0) return <p className="py-10 text-sm text-muted-foreground">{empty}</p>
  const points = series.map((bucket, index) => {
    const x = series.length === 1 ? 50 : (index / (series.length - 1)) * 100
    const y = 100 - ((bucket.p95_us ?? 0) / peak) * 100
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground tabular-nums">{peakLabel}</p>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-32 w-full text-primary" role="img" aria-label={peakLabel} data-slot="sql-performance-trend">
      <polygon points={`0,100 ${points.join(" ")} 100,100`} className="fill-primary/10" />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  </div>
}
