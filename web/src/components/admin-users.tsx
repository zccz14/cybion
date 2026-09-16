import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { LinkitUserInfo } from "linkit-react-components"
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, RefreshCwIcon } from "lucide-react"

import { formattedTime } from "@/lib/time"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Metrics = {
  requests: number; in_flight: number; input_tokens: number; output_tokens: number; total_tokens: number
  cached_tokens: number; cache_hit_rate: number | null; history_records: number; threads: number
  sqlite_bytes: number; sqlite_main_bytes: number; sqlite_wal_bytes: number; sqlite_shm_bytes: number
}
type Traffic = {
  worker_received_bytes: number; worker_sent_bytes: number
  upstream_received_bytes: number; upstream_sent_bytes: number; since: number
}
type User = { user_id: string; is_admin: boolean; metrics: Metrics | null; traffic: Traffic | null; error: string | null }
type Users = { items: User[]; generated_at: number }
type Sort = "user_id" | "requests" | "total_tokens" | "cache_hit_rate" | "history_records" | "threads" | "in_flight" | "sqlite_bytes" | "worker" | "upstream"
type Language = "en" | "zh"

const copy = {
  zh: {
    user: "用户", requests: "推理请求", tokens: "累计 Token", cache: "缓存率", history: "历史记录", threads: "线程",
    inFlight: "在途请求", sqlite: "SQLite", worker: "Worker 流量", upstream: "上游流量", admin: "管理员",
    search: "搜索用户 ID", refresh: "刷新", loading: "正在读取用户…", error: "无法读取用户列表", retry: "重试",
    unavailable: "该用户的统计暂不可用", required: "仅管理员可查看用户列表。", empty: "暂无用户",
    noMatch: "没有匹配的用户", clear: "清空搜索", emptyHint: "用户首次登录 Cybion 后会显示在这里。",
    input: "输入", output: "输出", cached: "缓存", sent: "发送", received: "接收", since: "流量起算", notMetered: "尚无流量",
    updated: "更新于", auto: "每 5 秒刷新", previous: "上一页", next: "下一页", definitions: "统计口径",
    usageNote: "推理请求包含普通推理和上下文压缩，覆盖所有状态。Token 为上游已报告的输入与输出之和，缓存率 = 缓存输入 Token ÷ 输入 Token。无输入用量时显示 —。请求和 Token 基于保留的审计记录；删除线程会移除相关审计。",
    networkNote: "流量从各用户首次计量起累计，分别显示 Cybion 向 Worker / 推理上游发送和接收的 HTTP 正文字节，包含 Worker 心跳和 SSE 帧，不含 HTTP 头与 TLS 开销。上线前流量无法回溯。",
    sqliteNote: "SQLite 为该用户数据库主文件、WAL 与 SHM 文件的合计。",
    count: (visible: number, total: number) => `${visible} / ${total} 位用户`,
  },
  en: {
    user: "User", requests: "Requests", tokens: "Total tokens", cache: "Cache rate", history: "History", threads: "Threads",
    inFlight: "In flight", sqlite: "SQLite", worker: "Worker traffic", upstream: "Upstream traffic", admin: "Admin",
    search: "Search user ID", refresh: "Refresh", loading: "Loading users…", error: "Could not load users", retry: "Retry",
    unavailable: "User metrics are unavailable", required: "Administrator access is required to view users.", empty: "No users yet",
    noMatch: "No matching users", clear: "Clear search", emptyHint: "Users appear here after their first Cybion sign-in.",
    input: "Input", output: "Output", cached: "Cached", sent: "Sent", received: "Received", since: "Traffic since", notMetered: "No traffic yet",
    updated: "Updated", auto: "Refreshes every 5 seconds", previous: "Previous", next: "Next", definitions: "Metric definitions",
    usageNote: "Requests include inference and context compaction in every status. Tokens add reported input and output usage; cache rate = cached input tokens ÷ input tokens. No input usage displays —. Request and token totals use retained audits; deleting a thread removes its audits.",
    networkNote: "Traffic accumulates from each user's first measurement. Sent and received HTTP body bytes are measured from Cybion to Workers / inference upstreams, including Worker heartbeats and SSE framing, excluding HTTP headers and TLS overhead. Traffic before deployment cannot be recovered.",
    sqliteNote: "SQLite includes the user's main database, WAL and SHM files.",
    count: (visible: number, total: number) => `${visible} / ${total} users`,
  },
}

function bytes(value: number) {
  const unit = Math.min(4, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)))
  return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`
}

function sortValue(user: User, key: Exclude<Sort, "user_id">): number | null {
  if (key === "worker") return user.traffic ? user.traffic.worker_sent_bytes + user.traffic.worker_received_bytes : 0
  if (key === "upstream") return user.traffic ? user.traffic.upstream_sent_bytes + user.traffic.upstream_received_bytes : 0
  return user.metrics?.[key] ?? null
}

export function AdminUsers({ language, request, allowed, sessionId }: {
  language: Language
  request: (signal: AbortSignal) => Promise<Users>
  allowed: boolean
  sessionId: string | null | undefined
}) {
  const t = copy[language]
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<Sort>("total_tokens")
  const [ascending, setAscending] = useState(false)
  const [page, setPage] = useState(0)
  const query = useQuery({
    queryKey: ["admin-users", sessionId],
    queryFn: ({ signal }) => request(signal),
    enabled: allowed,
    refetchInterval: 5000,
  })
  if (!allowed) return <p className="text-sm text-muted-foreground">{t.required}</p>

  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
  const filtered = (query.data?.items ?? []).filter((user) => user.user_id.toLowerCase().includes(search.trim().toLowerCase()))
  filtered.sort((a, b) => {
    if (sort === "user_id") return (ascending ? 1 : -1) * a.user_id.localeCompare(b.user_id)
    const av = sortValue(a, sort), bv = sortValue(b, sort)
    if (av === null || bv === null) return av === bv ? a.user_id.localeCompare(b.user_id) : av === null ? 1 : -1
    return (ascending ? av - bv : bv - av) || a.user_id.localeCompare(b.user_id)
  })
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1))
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25)
  const columns: [Sort, string][] = [["user_id", t.user], ["requests", t.requests], ["total_tokens", t.tokens], ["cache_hit_rate", t.cache], ["history_records", t.history], ["threads", t.threads], ["in_flight", t.inFlight], ["sqlite_bytes", t.sqlite], ["worker", t.worker], ["upstream", t.upstream]]
  function order(key: Sort) {
    setSort(key)
    setAscending(key === sort ? !ascending : key === "user_id")
    setPage(0)
  }
  function trafficCell(sent: number, received: number) {
    return <div className="flex flex-col items-end gap-1 tabular-nums">
      <span aria-label={`${t.sent} ${bytes(sent)}`}><span aria-hidden="true">↑ </span>{bytes(sent)}</span>
      <span aria-label={`${t.received} ${bytes(received)}`}><span aria-hidden="true">↓ </span>{bytes(received)}</span>
    </div>
  }
  return <section className="flex min-w-0 flex-col gap-4" aria-label={t.user}>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Field className="w-full gap-2 sm:w-72">
        <FieldLabel htmlFor="admin-user-search">{t.search}</FieldLabel>
        <Input id="admin-user-search" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        {query.data && <span className="text-sm text-muted-foreground">{t.count(filtered.length, query.data.items.length)}</span>}
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCwIcon data-icon="inline-start" />{t.refresh}</Button>
      </div>
    </div>
    {query.error && <Alert variant="destructive"><AlertTitle>{t.error}</AlertTitle><AlertDescription>{query.error.message}<Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t.retry}</Button></AlertDescription></Alert>}
    {query.isPending && <div aria-label={t.loading} className="flex flex-col gap-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>}
    {query.data && <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{t.updated} {formattedTime(language, query.data.generated_at)} · {t.auto}</span>
        <span>↑ {t.sent} · ↓ {t.received}</span>
      </div>
      <div className="min-w-0 rounded-lg border bg-card">
        <Table className="min-w-[76rem]">
          <TableHeader><TableRow>{columns.map(([key, label]) => <TableHead key={key} className={key === "user_id" ? "w-72" : "text-right"} aria-sort={sort === key ? ascending ? "ascending" : "descending" : "none"}>
            <Button variant="ghost" size="sm" className="px-1" onClick={() => order(key)}>{label}{sort === key ? ascending ? <ArrowUpIcon data-icon="inline-end" /> : <ArrowDownIcon data-icon="inline-end" /> : <ArrowUpDownIcon data-icon="inline-end" />}</Button>
          </TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {visible.map((user) => {
              const m = user.metrics, traffic = user.traffic
              return <TableRow key={user.user_id}>
                <TableCell>
                  <div className="flex flex-col gap-1.5 py-2">
                    <div className="flex items-center gap-2"><LinkitUserInfo userId={user.user_id} />{user.is_admin && <Badge variant="secondary">{t.admin}</Badge>}</div>
                    <code className="text-xs text-muted-foreground">{user.user_id}</code>
                    <span className="text-xs text-muted-foreground">{traffic ? `${t.since} ${formattedTime(language, traffic.since)}` : t.notMetered}</span>
                  </div>
                </TableCell>
                {m ? <>
                  <TableCell className="text-right tabular-nums">{number(m.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums"><div>{number(m.total_tokens)}</div><div className="mt-1 text-xs text-muted-foreground">{t.input} {number(m.input_tokens)}<br />{t.output} {number(m.output_tokens)}</div></TableCell>
                  <TableCell className="text-right tabular-nums"><div>{m.cache_hit_rate === null ? "—" : `${(m.cache_hit_rate * 100).toFixed(1)}%`}</div><div className="mt-1 text-xs text-muted-foreground">{t.cached} {number(m.cached_tokens)}</div></TableCell>
                  <TableCell className="text-right tabular-nums">{number(m.history_records)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(m.threads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.in_flight > 0 ? <Badge>{number(m.in_flight)}</Badge> : "0"}</TableCell>
                  <TableCell className="text-right tabular-nums" title={`DB ${bytes(m.sqlite_main_bytes)} · WAL ${bytes(m.sqlite_wal_bytes)} · SHM ${bytes(m.sqlite_shm_bytes)}`}>{bytes(m.sqlite_bytes)}</TableCell>
                </> : <TableCell colSpan={7}><span role="status" className="text-destructive">{t.unavailable}</span></TableCell>}
                <TableCell>{trafficCell(traffic?.worker_sent_bytes ?? 0, traffic?.worker_received_bytes ?? 0)}</TableCell>
                <TableCell>{trafficCell(traffic?.upstream_sent_bytes ?? 0, traffic?.upstream_received_bytes ?? 0)}</TableCell>
              </TableRow>
            })}
            {visible.length === 0 && <TableRow><TableCell colSpan={10} className="h-36 text-center"><p>{search ? t.noMatch : t.empty}</p>{search ? <Button variant="ghost" onClick={() => { setSearch(""); setPage(0) }}>{t.clear}</Button> : <p className="mt-1 text-sm text-muted-foreground">{t.emptyHint}</p>}</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      {filtered.length > 25 && <div className="flex items-center justify-end gap-3 text-sm"><span>{currentPage + 1} / {Math.ceil(filtered.length / 25)}</span><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t.previous}</Button><Button variant="outline" size="sm" disabled={(currentPage + 1) * 25 >= filtered.length} onClick={() => setPage(currentPage + 1)}>{t.next}</Button></div>}
    </>}
    <details className="text-sm text-muted-foreground"><summary className="cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">{t.definitions}</summary><div className="mt-2 flex max-w-3xl flex-col gap-2"><p>{t.usageNote}</p><p>{t.networkNote}</p><p>{t.sqliteNote}</p></div></details>
  </section>
}
