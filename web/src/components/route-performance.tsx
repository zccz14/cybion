import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { RefreshCwIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { cn, errorMessage } from "@/lib/utils"
import {
  errorRate,
  formatLatency,
  routePerformanceWindows,
  seriesPeak,
  sortRoutes,
  type RoutePerformance,
  type RoutePerformanceBucket,
  type RoutePerformanceRoute,
  type RoutePerformanceWindow,
  type RouteSortKey,
} from "@/lib/route-performance"
import { formattedTime } from "@/lib/time"

const copy = {
  en: {
    title: "Interface performance",
    description: "Every API route's requests, latency and outcomes, recorded while serving and read back from the shared database. The minute still running is read from memory, so the newest numbers are live.",
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
    requests: "Requests",
    errorRate: "Server errors",
    slow: "Slow requests",
    slowScope: "Requests at or above 1 s",
    latency: "Latency",
    p50: "P50",
    p95: "P95",
    p99: "P99",
    max: "Max",
    average: "Average",
    volume: "Requests",
    volumeDescription: "Requests served each {unit} of the window",
    trend: "P95 latency",
    trendDescription: "The 95th percentile of response time each {unit}",
    routes: "Routes",
    routesDescription: "Ordered by request count; click a column to sort",
    route: "Route",
    clientErrors: "4xx",
    serverErrors: "5xx",
    slowRequests: "Slow",
    statuses: "Statuses",
    empty: "No request has been recorded in this window yet.",
    slowTitle: "Slowest requests",
    slowDescription: "The twenty slowest single requests kept from the last 500 recorded",
    slowEmpty: "Nothing at or above 1 s in this window.",
    sampledAt: "Time",
    status: "Status",
    duration: "Duration",
    peak: "Peak {value}",
    loading: "Loading interface performance…",
    retry: "Retry",
    loadError: "Could not read interface performance",
    sortBy: "Sort by {column}",
  },
  zh: {
    title: "接口性能",
    description: "按接口路由统计请求量、延迟与结果。数据在服务请求时计量，写入公共数据库后读回；正在进行的这一分钟直接读内存，所以最新数字是实时的。",
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
    requests: "请求数",
    errorRate: "服务端错误",
    slow: "慢请求",
    slowScope: "耗时 ≥ 1 秒的请求",
    latency: "延迟",
    p50: "P50",
    p95: "P95",
    p99: "P99",
    max: "最大",
    average: "平均",
    volume: "请求量",
    volumeDescription: "区间内每{unit}处理的请求数",
    trend: "P95 延迟",
    trendDescription: "每{unit}响应时间的 95 分位",
    routes: "接口",
    routesDescription: "按请求数排序，点击列头可改排序",
    route: "接口",
    clientErrors: "4xx",
    serverErrors: "5xx",
    slowRequests: "慢",
    statuses: "状态码",
    empty: "这个区间还没有请求记录。",
    slowTitle: "最慢的请求",
    slowDescription: "保留最近 500 条慢请求，这里展示最慢的 20 条",
    slowEmpty: "这个区间没有 ≥ 1 秒的请求。",
    sampledAt: "时间",
    status: "状态",
    duration: "耗时",
    peak: "峰值 {value}",
    loading: "正在读取接口性能…",
    retry: "重试",
    loadError: "无法读取接口性能",
    sortBy: "按{column}排序",
  },
} as const

type Props = {
  language: "en" | "zh"
  sessionId: string | null | undefined
  request: <T>(path: string, init?: RequestInit) => Promise<T>
}

const windowLabels: Record<RoutePerformanceWindow, keyof typeof copy.en> = {
  "1h": "hours1",
  "6h": "hours6",
  "24h": "hours24",
  "7d": "days7",
}

type RouteColumn = { key: RouteSortKey | null; label: keyof typeof copy.en; numeric: boolean; narrow?: string }

// A narrow screen keeps the numbers an operator acts on and drops the ones that
// only narrow a diagnosis; the full table returns as soon as there is room.
const columns: RouteColumn[] = [
  { key: null, label: "route", numeric: false },
  { key: "requests", label: "requests", numeric: true },
  { key: "client_errors", label: "clientErrors", numeric: true, narrow: "hidden md:table-cell" },
  { key: "server_errors", label: "serverErrors", numeric: true },
  { key: "slow_requests", label: "slowRequests", numeric: true, narrow: "hidden sm:table-cell" },
  { key: "average_us", label: "average", numeric: true },
  { key: null, label: "p50", numeric: true, narrow: "hidden md:table-cell" },
  { key: "p95_us", label: "p95", numeric: true },
  { key: null, label: "p99", numeric: true, narrow: "hidden lg:table-cell" },
  { key: "max_us", label: "max", numeric: true },
]

export function RoutePerformance({ language, sessionId, request }: Props) {
  return <RoutePerformanceSession key={sessionId} language={language} sessionId={sessionId} request={request} />
}

function RoutePerformanceSession({ language, sessionId, request }: Props) {
  const t = copy[language]
  const [window, setWindow] = useState<RoutePerformanceWindow>("24h")
  const [sortKey, setSortKey] = useState<RouteSortKey>("requests")
  const [descending, setDescending] = useState(true)
  const query = useQuery({
    queryKey: ["route-performance", sessionId, window],
    queryFn: ({ signal }) => request<RoutePerformance>(`/api/route-performance?window=${window}`, { signal }),
    refetchInterval: 10_000,
  })
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  const percent = (value: number | null) =>
    value === null ? "—" : `${value.toLocaleString(language === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 1 })}%`
  const sort = (key: RouteSortKey) => {
    if (key === sortKey) setDescending(!descending)
    else {
      setSortKey(key)
      setDescending(true)
    }
  }
  const routes = useMemo(
    () => (query.data ? sortRoutes(query.data.routes, sortKey, descending) : []),
    [query.data, sortKey, descending],
  )
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
    [t.requests, number(totals.requests)],
    [t.errorRate, percent(errorRate(totals.server_errors, totals.requests))],
    [t.p95, formatLatency(totals.p95_us)],
    [t.max, formatLatency(totals.max_us)],
    [t.slow, number(totals.slow_requests)],
    [t.average, formatLatency(totals.average_us)],
    [t.p50, formatLatency(totals.p50_us)],
    [t.p99, formatLatency(totals.p99_us)],
  ]
  return <div className="flex flex-col gap-6">
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 pt-6">
        <Select value={window} onValueChange={(value) => setWindow(value as RoutePerformanceWindow)}>
          <SelectTrigger aria-label={t.window} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {routePerformanceWindows.map((option) => <SelectItem key={option} value={option}>{t[windowLabels[option]]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Badge variant="outline">{unit}</Badge>
        <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
          <RefreshCwIcon data-icon="inline-start" />{t.refresh}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground" data-slot="route-performance-freshness">
          {t.generated.replace("{time}", formattedTime(language, data.generated_at))}
          {data.latest_bucket_start === null ? "" : ` · ${t.coverage.replace("{time}", formattedTime(language, data.latest_bucket_start))}`}
        </span>
      </CardContent>
    </Card>
    <Card>
      <CardContent className="pt-6">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4" data-slot="route-performance-totals">
          {metrics.map(([label, value]) => <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd>
          </div>)}
        </dl>
      </CardContent>
    </Card>
    <section className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t.volume}</CardTitle>
          <CardDescription>{withUnit(t.volumeDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestVolume series={data.series} peakLabel={t.peak.replace("{value}", number(seriesPeak(data.series)))} empty={t.empty} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.trend}</CardTitle>
          <CardDescription>{withUnit(t.trendDescription)}</CardDescription>
        </CardHeader>
        <CardContent>
          <LatencyTrend series={data.series} peakLabel={t.peak.replace("{value}", formatLatency(seriesPeak(data.series, "p95_us")))} empty={t.empty} />
        </CardContent>
      </Card>
    </section>
    <Card>
      <CardHeader>
        <CardTitle>{t.routes}</CardTitle>
        <CardDescription>{t.routesDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        {routes.length === 0
          ? <p className="py-6 text-sm text-muted-foreground">{t.empty}</p>
          : <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm" data-slot="route-performance-routes">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>{columns.map((column) => <th key={column.label} aria-sort={column.key === sortKey ? (descending ? "descending" : "ascending") : "none"} className={cn("px-3 py-2 font-medium", column.numeric && "text-right", column.narrow)}>
                  {column.key === null
                    ? t[column.label]
                    : <button type="button" aria-label={t.sortBy.replace("{column}", t[column.label])} onClick={() => sort(column.key!)} className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                      {t[column.label]}{column.key === sortKey ? <span aria-hidden="true">{descending ? "↓" : "↑"}</span> : null}
                    </button>}
                </th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {routes.map((route) => <RouteRow key={`${route.method} ${route.route}`} route={route} formatLatency={formatLatency} number={number} />)}
              </tbody>
            </table>
          </div>}
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>{t.slowTitle}</CardTitle>
        <CardDescription>{t.slowDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        {data.slow.length === 0
          ? <p className="py-6 text-sm text-muted-foreground">{t.slowEmpty}</p>
          : <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm" data-slot="route-performance-slow">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t.sampledAt}</th>
                  <th className="px-3 py-2 font-medium">{t.route}</th>
                  <th className="px-3 py-2 font-medium">{t.status}</th>
                  <th className="px-3 py-2 text-right font-medium">{t.duration}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.slow.map((sample) => <tr key={`${sample.sampled_at}-${sample.method}-${sample.route}-${sample.latency_us}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formattedTime(language, sample.sampled_at)}</td>
                  <td className="px-3 py-2"><RouteName method={sample.method} route={sample.route} /></td>
                  <td className="px-3 py-2"><StatusBadge status={sample.status} /></td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{formatLatency(sample.latency_us)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
      </CardContent>
    </Card>
  </div>
}

function RouteRow({
  route,
  formatLatency,
  number,
}: {
  route: RoutePerformanceRoute
  formatLatency: (value: number | null | undefined) => string
  number: (value: number) => string
}) {
  const value = (label: RouteColumn["label"]) => {
    switch (label) {
      case "route":
        return <RouteName method={route.method} route={route.route} />
      case "requests":
        return number(route.requests)
      case "clientErrors":
        return route.client_errors === 0 ? "—" : number(route.client_errors)
      case "serverErrors":
        return route.server_errors === 0 ? "—" : number(route.server_errors)
      case "slowRequests":
        return route.slow_requests === 0 ? "—" : number(route.slow_requests)
      case "average":
        return formatLatency(route.average_us)
      case "p50":
        return formatLatency(route.p50_us)
      case "p95":
        return formatLatency(route.p95_us)
      case "p99":
        return formatLatency(route.p99_us)
      case "max":
        return formatLatency(route.max_us)
      default:
        return "—"
    }
  }
  return <tr data-slot="route-performance-route">
    {columns.map((column) => <td
      key={column.label}
      className={cn(
        "px-3 py-2",
        column.numeric && "text-right font-mono tabular-nums",
        column.label === "serverErrors" && route.server_errors > 0 && "text-destructive",
        column.narrow,
      )}
    >{value(column.label)}</td>)}
  </tr>
}

function RouteName({ method, route }: { method: string; route: string }) {
  return <span className="flex min-w-0 items-center gap-2">
    <Badge variant={method === "GET" ? "secondary" : "outline"} className="shrink-0 font-mono text-[10px]">{method}</Badge>
    <code className="truncate text-xs" title={route}>{route}</code>
  </span>
}

function StatusBadge({ status }: { status: number }) {
  const variant = status >= 500 ? "destructive" : status >= 400 ? "outline" : "secondary"
  return <Badge variant={variant} className="font-mono text-[10px] tabular-nums">{status}</Badge>
}

function RequestVolume({ series, peakLabel, empty }: { series: RoutePerformanceBucket[]; peakLabel: string; empty: string }) {
  const peak = seriesPeak(series)
  if (series.length === 0) return <p className="py-10 text-sm text-muted-foreground">{empty}</p>
  return <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground tabular-nums">{peakLabel}</p>
    <div className="flex h-32 items-end gap-px" data-slot="route-performance-volume">
      {series.map((bucket) => <div
        key={bucket.bucket_start}
        title={`${bucket.requests}`}
        className={`min-w-px flex-1 rounded-t-sm ${bucket.server_errors > 0 ? "bg-destructive/80" : "bg-primary/70"}`}
        style={{ height: `${Math.max(2, (bucket.requests / peak) * 100)}%` }}
      />)}
    </div>
  </div>
}

function LatencyTrend({ series, peakLabel, empty }: { series: RoutePerformanceBucket[]; peakLabel: string; empty: string }) {
  const peak = seriesPeak(series, "p95_us")
  if (series.length === 0) return <p className="py-10 text-sm text-muted-foreground">{empty}</p>
  const points = series.map((bucket, index) => {
    const x = series.length === 1 ? 50 : (index / (series.length - 1)) * 100
    const y = 100 - ((bucket.p95_us ?? 0) / peak) * 100
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return <div className="flex flex-col gap-2">
    <p className="text-xs text-muted-foreground tabular-nums">{peakLabel}</p>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-32 w-full text-primary" role="img" aria-label={peakLabel} data-slot="route-performance-trend">
      <polygon points={`0,100 ${points.join(" ")} 100,100`} className="fill-primary/10" />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  </div>
}
