import { Fragment, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, ChevronDownIcon, ChevronRightIcon, DatabaseIcon, LinkIcon, RefreshCwIcon, SearchIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const columns = ["id", "thread_id", "request_input_id", "role", "content", "kind", "payload", "visible", "created_at"] as const
type Column = typeof columns[number]
type RawRecord = {
  id: number
  thread_id: string
  request_input_id: number | null
  role: string
  content: string
  kind: string
  payload: string
  visible: number
  created_at: number
}
type Preview = RawRecord & { thread_title: string; content_truncated: boolean; payload_truncated: boolean }
type RecordPage = { items: Preview[]; total: number; page: number; page_size: number; sort: Column; direction: "asc" | "desc" }
type Request = <T>(path: string, signal?: AbortSignal) => Promise<T>
type Language = "en" | "zh"

const copy = {
  en: {
    readOnly: "Read only", search: "Search content / payload", searchHint: "Exact text · case sensitive",
    apply: "Apply filters", reset: "Clear filters", all: "All", more: "ID, thread & time filters",
    from: "created_at from (local time)", to: "created_at to (local time)",
    refresh: "Refresh", previous: "Previous", next: "Next", first: "First", last: "Last", perPage: "Per page", page: "Page",
    loading: "Loading records…", error: "Could not load records", retry: "Retry",
    empty: "No matching records", emptyHint: "Clear the filters or wait for new history to be recorded.",
    note: "Includes visible = 0. Text cells are previews; expand a row for complete stored values. Times use your local time zone.",
    openThread: "Open thread",
    expand: "Expand record", collapse: "Collapse record", details: "Stored values", preview: "Preview", raw: "Full stored text",
    rows: (start: number, end: number, total: number) => `${start}–${end} of ${total} rows`,
    sort: (column: string, direction: string) => `Sort ${column} ${direction === "asc" ? "ascending" : "descending"}`,
  },
  zh: {
    readOnly: "只读", search: "搜索 content / payload", searchHint: "原文匹配 · 区分大小写",
    apply: "应用筛选", reset: "清空筛选", all: "全部", more: "ID、线程与时间筛选",
    from: "created_at 起始（本地时间）", to: "created_at 截止（本地时间）",
    refresh: "刷新", previous: "上一页", next: "下一页", first: "首页", last: "末页", perPage: "每页", page: "页码",
    loading: "正在读取记录…", error: "无法读取记录", retry: "重试",
    empty: "没有匹配的记录", emptyHint: "清空筛选条件，或等待新的历史记录写入。",
    note: "包含 visible = 0 的记录。文本单元格为预览，展开行可查看完整存储值。时间使用本地时区。",
    openThread: "打开线程",
    expand: "展开记录", collapse: "收起记录", details: "存储字段", preview: "预览", raw: "完整存储原文",
    rows: (start: number, end: number, total: number) => `第 ${start}–${end} 条，共 ${total} 条`,
    sort: (column: string, direction: string) => `按 ${column} ${direction === "asc" ? "升序" : "降序"}排列`,
  },
}
type Copy = typeof copy[Language]
const filterKeys = ["q", "id", "thread_id", "request_input_id", "kind", "role", "visible", "created_from", "created_to"] as const

function localDateTime(value: string | null) {
  if (!value) return ""
  const date = new Date(Number(value) * 1000)
  if (!Number.isFinite(date.getTime())) return ""
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19)
}

function historyTime(timestamp: number, language: Language) {
  return new Date(timestamp * 1000).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
}

function FilterSelect({ name, values, value, all }: { name: string; values: string[]; value: string | null; all: string }) {
  return <Field className="gap-2">
    <FieldLabel htmlFor={`history-${name}`}>{name}</FieldLabel>
    <Select name={name} defaultValue={value || "all"}>
      <SelectTrigger id={`history-${name}`} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup><SelectItem value="all">{all}</SelectItem>{values.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>
  </Field>
}

export function HistoryTable({ language, request }: { language: Language; request: Request }) {
  const t = copy[language]
  const [params, setParams] = useSearchParams()
  const [filterReset, setFilterReset] = useState(0)
  const queryString = params.toString()
  const query = useQuery({
    queryKey: ["history-table", queryString],
    queryFn: ({ signal }) => request<RecordPage>(`/api/history?${queryString}`, signal),
  })
  const data = query.data
  const page = data?.page ?? 1
  const pageSize = data?.page_size ?? Number(params.get("page_size") || 20)
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  const sort = data?.sort ?? params.get("sort") ?? "id"
  const direction = data?.direction ?? params.get("direction") ?? "desc"
  const filters = new URLSearchParams([...params].filter(([key]) => (filterKeys as readonly string[]).includes(key))).toString()
  const hasFilters = Boolean(filters)
  const advanced = ["id", "thread_id", "request_input_id", "created_from", "created_to"].some((key) => params.has(key))

  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params)
    Object.entries(values).forEach(([key, value]) => next.set(key, value))
    setParams(next)
  }

  function clearFilters() {
    const next = new URLSearchParams(params)
    filterKeys.forEach((key) => next.delete(key))
    next.set("page", "1")
    setFilterReset((value) => value + 1)
    setParams(next)
  }

  return <section className="flex min-w-0 flex-col gap-4" aria-label="history_records">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><DatabaseIcon className="size-4 text-muted-foreground" aria-hidden="true" /><h2 className="font-mono text-sm font-semibold">history_records</h2><Badge variant="outline">{t.readOnly}</Badge></div>
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCwIcon data-icon="inline-start" />{t.refresh}</Button>
    </div>
    <form key={`${filters}:${filterReset}`} className="flex flex-col gap-3" onSubmit={(event) => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const next = new URLSearchParams(params)
      filterKeys.forEach((key) => {
        const value = String(form.get(key) ?? "")
        next.delete(key)
        if (value && !(value === "all" && ["kind", "role", "visible"].includes(key))) next.set(key, key.startsWith("created_") ? String(Math.floor(new Date(value).getTime() / 1000)) : value)
      })
      next.set("page", "1")
      setParams(next)
    }}>
      <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,2fr)_1fr_1fr_1fr]">
        <Field className="gap-2"><FieldLabel htmlFor="history-q">{t.search}</FieldLabel><Input id="history-q" name="q" defaultValue={params.get("q") ?? ""} placeholder={t.searchHint} /></Field>
        <FilterSelect name="kind" values={["input", "response_output", "tool_output", "checkpoint", "activity"]} value={params.get("kind")} all={t.all} />
        <FilterSelect name="role" values={["user", "assistant", "tool", "system"]} value={params.get("role")} all={t.all} />
        <FilterSelect name="visible" values={["0", "1"]} value={params.get("visible")} all={t.all} />
      </FieldGroup>
      <details open={advanced || undefined} className="text-sm">
        <summary className="w-fit cursor-pointer rounded-sm py-1 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">{t.more}</summary>
        <FieldGroup className="grid gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-3">
          {["id", "request_input_id", "thread_id"].map((name) => <Field key={name} className="gap-2"><FieldLabel htmlFor={`history-${name}`}>{name}</FieldLabel><Input id={`history-${name}`} name={name} type={name === "thread_id" ? "text" : "number"} min="1" step="1" defaultValue={params.get(name) ?? ""} /></Field>)}
          <Field className="gap-2"><FieldLabel htmlFor="history-created-from">{t.from}</FieldLabel><Input id="history-created-from" name="created_from" type="datetime-local" step="1" defaultValue={localDateTime(params.get("created_from"))} /></Field>
          <Field className="gap-2"><FieldLabel htmlFor="history-created-to">{t.to}</FieldLabel><Input id="history-created-to" name="created_to" type="datetime-local" step="1" defaultValue={localDateTime(params.get("created_to"))} /></Field>
        </FieldGroup>
      </details>
      <div className="flex flex-wrap gap-2"><Button type="submit"><SearchIcon data-icon="inline-start" />{t.apply}</Button><Button type="button" variant="outline" onClick={clearFilters}>{t.reset}</Button></div>
    </form>
    <p id="history-table-note" className="text-xs leading-5 text-muted-foreground">{t.note}</p>
    {query.error && <LoadError error={query.error} retry={() => void query.refetch()} t={t} />}
    <div className="min-w-0 rounded-lg border bg-card" aria-busy={query.isFetching}>
      <Table aria-label="history_records" aria-describedby="history-table-note">
        <TableHeader><TableRow>
          <TableHead><span className="sr-only">{t.details}</span></TableHead>
          {columns.map((column) => {
            const nextDirection = sort === column && direction === "asc" ? "desc" : "asc"
            const SortIcon = sort === column ? direction === "asc" ? ArrowUpIcon : ArrowDownIcon : ArrowUpDownIcon
            return <TableHead key={column} scope="col" aria-sort={sort === column ? direction === "asc" ? "ascending" : "descending" : "none"}>
              <Button variant="ghost" size="sm" disabled={query.isFetching} aria-label={t.sort(column, nextDirection)} onClick={() => update({ sort: column, direction: nextDirection, page: "1" })}><span className="font-mono">{column}</span><SortIcon data-icon="inline-end" /></Button>
            </TableHead>
          })}
        </TableRow></TableHeader>
        <TableBody>
          {query.isPending && Array.from({ length: 5 }, (_, i) => <TableRow key={i}><TableCell colSpan={10}><Skeleton className="h-9 w-full" /><span className="sr-only">{t.loading}</span></TableCell></TableRow>)}
          {data?.items.map((record) => <RecordRows key={`${queryString}:${record.id}`} record={record} language={language} request={request} />)}
          {data?.items.length === 0 && <TableRow><TableCell colSpan={10} className="h-36 whitespace-normal text-center"><p className="font-medium">{t.empty}</p><p className="mt-1 text-sm text-muted-foreground">{t.emptyHint}</p>{hasFilters && <Button variant="link" onClick={clearFilters}>{t.reset}</Button>}</TableCell></TableRow>}
        </TableBody>
      </Table>
    </div>
    {data && <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm tabular-nums text-muted-foreground" role="status">{t.rows(data.total ? (page - 1) * pageSize + 1 : 0, Math.min(page * pageSize, data.total), data.total)}</p>
      <nav aria-label={t.page} className="flex flex-wrap items-center gap-2">
        <label htmlFor="history-page-size" className="text-sm text-muted-foreground">{t.perPage}</label>
        <Select value={String(pageSize)} onValueChange={(value) => update({ page_size: value, page: "1" })}><SelectTrigger id="history-page-size" size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{[...new Set([20, 50, 100, pageSize])].sort((a, b) => a - b).map((value) => <SelectItem key={value} value={String(value)}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select>
        <Button size="sm" variant="outline" disabled={query.isFetching || page === 1} onClick={() => update({ page: "1" })}>{t.first}</Button>
        <Button size="sm" variant="outline" disabled={query.isFetching || page === 1} onClick={() => update({ page: String(page - 1) })}>{t.previous}</Button>
        <span className="px-1 text-sm tabular-nums">{page} / {pages}</span>
        <Button size="sm" variant="outline" disabled={query.isFetching || page >= pages} onClick={() => update({ page: String(page + 1) })}>{t.next}</Button>
        <Button size="sm" variant="outline" disabled={query.isFetching || page >= pages} onClick={() => update({ page: String(pages) })}>{t.last}</Button>
      </nav>
    </div>}
  </section>
}

function RecordRows({ record, language, request }: { record: Preview; language: Language; request: Request }) {
  const t = copy[language]
  const [expanded, setExpanded] = useState(false)
  return <Fragment>
    <TableRow>
      <TableCell><Button size="icon-sm" variant="ghost" aria-label={`${expanded ? t.collapse : t.expand} #${record.id}`} aria-expanded={expanded} aria-controls={`history-detail-${record.id}`} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</Button></TableCell>
      {columns.map((column) => <TableCell key={column}>
        {column === "content" || column === "payload" ? <div className="w-64"><pre className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs leading-5">{record[column] === "" ? '""' : record[column]}</pre>{record[`${column}_truncated`] && <span className="text-xs text-muted-foreground">… {t.preview}</span>}</div>
          : column === "thread_id" ? <div className="flex max-w-80 flex-col gap-1"><span className="truncate font-medium" title={record.thread_title}>{record.thread_title}</span><div className="flex items-center gap-1"><code className="text-xs text-muted-foreground">{record.thread_id}</code><Button asChild size="icon-xs" variant="ghost"><Link to={`/threads/${encodeURIComponent(record.thread_id)}`} aria-label={`${t.openThread}: ${record.thread_title}`} title={t.openThread}><LinkIcon /></Link></Button></div></div>
          : column === "created_at" ? <time dateTime={new Date(record.created_at * 1000).toISOString()} className="text-xs tabular-nums">{historyTime(record.created_at, language)}</time>
          : <code className="text-xs tabular-nums">{record[column] === null ? "NULL" : record[column]}</code>}
      </TableCell>)}
    </TableRow>
    {expanded && <TableRow><TableCell colSpan={10} className="whitespace-normal p-4 align-top"><RecordDetail id={record.id} request={request} language={language} /></TableCell></TableRow>}
  </Fragment>
}

function RecordDetail({ id, request, language }: { id: number; request: Request; language: Language }) {
  const t = copy[language]
  const detail = useQuery({ queryKey: ["history-table-record", id], queryFn: ({ signal }) => request<RawRecord>(`/api/history/${id}`, signal), gcTime: 0 })
  return <div id={`history-detail-${id}`} role="region" aria-label={`${t.details} #${id}`} className="sticky left-4 flex max-w-[min(65rem,calc(100vw-4rem))] flex-col gap-3 md:max-w-[min(65rem,calc(100vw-22rem))]">
        <h3 className="text-sm font-semibold">#{id} · {t.details}</h3>
        {detail.isPending && <Skeleton className="h-28 w-full" />}
        {detail.error && <LoadError error={detail.error} retry={() => void detail.refetch()} t={t} />}
        {detail.data && <>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{columns.filter((column) => column !== "content" && column !== "payload").map((column) => <div key={column} className="flex flex-wrap gap-x-3"><dt className="font-mono text-xs text-muted-foreground">{column}</dt><dd className="break-all font-mono text-xs">{column === "created_at" ? historyTime(detail.data!.created_at, language) : detail.data![column] === null ? "NULL" : detail.data![column]}</dd></div>)}</dl>
          {(["content", "payload"] as const).map((column) => <div key={column}><h4 className="mb-2 text-xs font-medium"><code>{column}</code> · {t.raw}</h4><pre tabIndex={0} className="max-h-96 overflow-auto rounded-md border bg-background p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">{detail.data![column] === "" ? '""' : detail.data![column]}</pre></div>)}
        </>}
      </div>
}

function LoadError({ error, retry, t }: { error: Error; retry: () => void; t: Copy }) {
  return <Alert variant="destructive"><AlertTitle>{t.error}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-2"><span>{error.message}</span><Button variant="outline" size="sm" onClick={retry}>{t.retry}</Button></AlertDescription></Alert>
}
