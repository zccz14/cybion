import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom"
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AuthMiniButton, AuthMiniProvider, useAuthMini } from "auth-mini-react-components"
import type { AuthMiniApi } from "auth-mini/sdk/browser"
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  KeyRoundIcon,
  LanguagesIcon,
  MenuIcon,
  MonitorCogIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react"

import "./styles.css"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

type Language = "en" | "zh"
type Thread = { id: string; title: string; model: string; status: "idle" | "running" | "failed"; created_at: number; updated_at: number }
type HistoryRecord = { id: number; thread_id: string; role: "user" | "assistant" | "tool" | "system"; content: string; created_at: number }
type Run = { id: string; thread_id: string; status: "queued" | "running" | "completed" | "failed"; error?: string | null; started_at: number; finished_at?: number | null }
type ApiKey = { id: string; label: string; prefix: string; created_at: number; last_used_at?: number | null }
type CreatedApiKey = ApiKey & { secret: string }
type Worker = { id: string; label: string; created_at: number; last_seen_at?: number | null; status: "online" | "offline"; resource?: Record<string, unknown> | null }
type WorkerPairing = { controller_url: string; tenant_id: string; machine_id: string; access_token: string }

const copy = {
  en: {
    threads: "Threads", newThread: "New thread", threadName: "Thread name", create: "Create", cancel: "Cancel", emptyTitle: "No threads yet", emptyDescription: "Start a focused thread. Every thread has its own history and run state.",
    chat: "Thread", send: "Send", input: "Give this thread its next instruction…", running: "Running", idle: "Idle", failed: "Failed", queued: "Queued", rename: "Rename", delete: "Delete", deleteTitle: "Delete this thread?", deleteDescription: "Its history, runs, Worker calls, and files for this thread will be removed.",
    api: "API", apiTitle: "Integration API", apiDescription: "Use an API key to create threads and append inputs from another application.", apiKeyLabel: "Key label", createKey: "Create API key", copyNow: "Copy this key now", keyWarning: "This secret is shown only once.", revoke: "Revoke", noKeys: "No API keys yet.",
    workers: "Workers", workersTitle: "Cybion Worker", workersDescription: "Pair a SQLite-free Worker on a personal device. It receives tool calls by SSE and returns results over HTTPS.", workerName: "Worker name", pair: "Create pairing", copyConfig: "Copy worker.toml", noWorkers: "No Workers paired.", online: "Online", offline: "Offline", remove: "Remove",
    theme: "Theme", language: "Language", light: "Light", dark: "Dark", menu: "Open thread list", model: "Model", updated: "Updated", start: "Start a thread", loadError: "Could not load this tenant", retry: "Retry", system: "System", assistant: "Cybion", user: "You", worker: "Worker", close: "Close",
  },
  zh: {
    threads: "线程", newThread: "新建线程", threadName: "线程名称", create: "创建", cancel: "取消", emptyTitle: "还没有线程", emptyDescription: "创建一个聚焦的线程。每个线程都拥有独立的历史和运行状态。",
    chat: "线程", send: "发送", input: "为这个线程追加下一条指令…", running: "运行中", idle: "空闲", failed: "失败", queued: "排队中", rename: "重命名", delete: "删除", deleteTitle: "删除这个线程？", deleteDescription: "该线程的历史、运行、Worker 调用及文件都会被删除。",
    api: "API", apiTitle: "集成 API", apiDescription: "使用 API Key 让其他应用创建线程或追加输入。", apiKeyLabel: "Key 名称", createKey: "创建 API Key", copyNow: "立即复制此 Key", keyWarning: "密钥只会显示一次。", revoke: "撤销", noKeys: "还没有 API Key。",
    workers: "Workers", workersTitle: "Cybion Worker", workersDescription: "在个人设备上配对一个无 SQLite 的 Worker；它通过 SSE 接收工具调用并通过 HTTPS 回传结果。", workerName: "Worker 名称", pair: "创建配对", copyConfig: "复制 worker.toml", noWorkers: "还没有配对的 Worker。", online: "在线", offline: "离线", remove: "移除",
    theme: "主题", language: "语言", light: "浅色", dark: "深色", menu: "打开线程列表", model: "模型", updated: "更新时间", start: "创建线程", loadError: "无法加载这个租户", retry: "重试", system: "系统", assistant: "Cybion", user: "你", worker: "Worker", close: "关闭",
  },
} as const

const queryClient = new QueryClient()

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Request failed" }
function callbackUrl() { return `${location.origin}${location.pathname}#/auth/callback` }
function formattedTime(language: Language, value: number) { return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(value * 1000) }

const AUTH_AUDIENCES = ["cybion.ntnl.io", "linkit.ntnl.io", "openai.ntnl.io"] as const

async function accessToken(sdk: AuthMiniApi) {
  const session = sdk.session.getState()
  if (!session.accessToken) throw new Error("Auth Mini session is not available")
  const expiresAt = Date.parse(session.expiresAt ?? "")
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
    const refreshed = await sdk.session.refresh()
    if (!refreshed.accessToken) throw new Error("Auth Mini session refresh failed")
    return refreshed.accessToken
  }
  return session.accessToken
}

async function api<T>(sdk: AuthMiniApi, path: string, init?: RequestInit): Promise<T> {
  const request = async (token: string) => fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers } })
  const first = await request(await accessToken(sdk))
  const response = first.status === 401 ? await request(await accessToken(sdk)) : first
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error ?? response.statusText)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function App() {
  return <AuthMiniProvider authMiniBaseUrl="https://auth.ntnl.io" audiences={AUTH_AUDIENCES} callbackUrl={callbackUrl()} autoRedirectToLogin><AuthenticatedApp /></AuthMiniProvider>
}

function AuthenticatedApp() {
  const { isReady, isAuthenticated, sdk } = useAuthMini()
  if (!isReady || !isAuthenticated || !sdk) return <LoadingScreen />
  return <Workspace sdk={sdk} />
}

function LoadingScreen() {
  return <main className="flex min-h-svh items-center justify-center bg-background"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Cybion</div></main>
}

function Workspace({ sdk }: { sdk: AuthMiniApi }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem("cybion.language") === "zh" ? "zh" : "en")
  const [dark, setDark] = useState(() => localStorage.getItem("cybion.theme") === "dark" || (!localStorage.getItem("cybion.theme") && matchMedia("(prefers-color-scheme: dark)").matches))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [apiOpen, setApiOpen] = useState(false)
  const [workersOpen, setWorkersOpen] = useState(false)
  const t = copy[language]
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<Thread[]>(sdk, "/api/threads"), refetchInterval: 2000 })
  const createThread = useMutation({
    mutationFn: (title: string) => api<Thread>(sdk, "/api/threads", { method: "POST", body: JSON.stringify({ title }) }),
    onSuccess: (thread) => { void client.invalidateQueries({ queryKey: ["threads"] }); setCreateOpen(false); navigate(`/threads/${thread.id}`) },
  })
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-CN" : "en"; localStorage.setItem("cybion.language", language) }, [language])
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("cybion.theme", dark ? "dark" : "light") }, [dark])
  const navigation = <ThreadNavigation threads={threads.data ?? []} loading={threads.isLoading} error={threads.error} language={language} onCreate={() => setCreateOpen(true)} onNavigate={(id) => { setDrawerOpen(false); navigate(`/threads/${id}`) }} />
  return <div className="min-h-svh bg-background text-foreground md:flex">
    <aside className="hidden w-72 shrink-0 border-r bg-sidebar md:flex md:flex-col">{navigation}</aside>
    <main className="flex min-h-svh min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
        <Button className="md:hidden" variant="ghost" size="icon-sm" onClick={() => setDrawerOpen(true)} aria-label={t.menu}><MenuIcon /></Button>
        <div className="min-w-0"><p className="truncate font-medium">Cybion</p><p className="hidden text-xs text-muted-foreground sm:block">{t.threads}</p></div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={t.api} onClick={() => setApiOpen(true)}><KeyRoundIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t.workers} onClick={() => setWorkersOpen(true)}><MonitorCogIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t.language} onClick={() => setLanguage(language === "en" ? "zh" : "en")}><LanguagesIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t.theme} onClick={() => setDark(!dark)}>{dark ? <SunIcon /> : <MoonIcon />}</Button>
          <AuthMiniButton lang={language} size="sm" variant="ghost" />
        </div>
      </header>
      {threads.isError && <div className="p-4"><RequestError language={language} error={threads.error} onRetry={() => void threads.refetch()} /></div>}
      {!threads.isError && <Routes>
        <Route path="/threads" element={<ThreadEmpty language={language} onCreate={() => setCreateOpen(true)} />} />
        <Route path="/threads/:threadId" element={<ThreadConversation sdk={sdk} language={language} onCreate={() => setCreateOpen(true)} />} />
        <Route path="*" element={<Navigate to="/threads" replace />} />
      </Routes>}
    </main>
    <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}><SheetContent side="left" className="w-80 bg-sidebar p-0"><SheetHeader className="sr-only"><SheetTitle>{t.threads}</SheetTitle><SheetDescription>{t.threads}</SheetDescription></SheetHeader>{navigation}</SheetContent></Sheet>
    <CreateThreadDialog language={language} open={createOpen} pending={createThread.isPending} error={createThread.error} onClose={() => setCreateOpen(false)} onCreate={(title) => createThread.mutate(title)} />
    <ApiKeysDialog sdk={sdk} language={language} open={apiOpen} onClose={() => setApiOpen(false)} />
    <WorkersDialog sdk={sdk} language={language} open={workersOpen} onClose={() => setWorkersOpen(false)} />
  </div>
}

function ThreadNavigation({ threads, loading, error, language, onCreate, onNavigate }: { threads: Thread[]; loading: boolean; error: unknown; language: Language; onCreate: () => void; onNavigate: (id: string) => void }) {
  const t = copy[language]
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 px-4 py-4"><div><h1 className="font-semibold">Cybion</h1><p className="text-xs text-muted-foreground">{t.threads}</p></div><Button size="icon-sm" aria-label={t.newThread} onClick={onCreate}><PlusIcon /></Button></div>
    <Separator />
    <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t.threads}>
      {loading && <div className="flex flex-col gap-2 p-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {Boolean(error) && <p className="p-2 text-sm text-destructive">{t.loadError}</p>}
      {!loading && !error && threads.map((thread) => <Button key={thread.id} className="w-full justify-start" variant="ghost" onClick={() => onNavigate(thread.id)}><StatusDot status={thread.status} /><span className="min-w-0 flex-1 truncate text-left">{thread.title}</span></Button>)}
    </nav>
    <div className="border-t p-3"><Button className="w-full" variant="outline" onClick={onCreate}><PlusIcon data-icon="inline-start" />{t.newThread}</Button></div>
  </div>
}

function StatusDot({ status }: { status: Thread["status"] }) { return <span aria-label={status} className={status === "running" ? "size-2 shrink-0 rounded-full bg-primary" : status === "failed" ? "size-2 shrink-0 rounded-full bg-destructive" : "size-2 shrink-0 rounded-full bg-muted-foreground/45"} /> }

function ThreadEmpty({ language, onCreate }: { language: Language; onCreate: () => void }) {
  const t = copy[language]
  return <section className="flex min-h-0 flex-1 items-center justify-center p-6"><div className="max-w-md text-center"><h1 className="text-xl font-semibold text-balance">{t.emptyTitle}</h1><p className="mt-2 text-sm leading-6 text-muted-foreground text-pretty">{t.emptyDescription}</p><Button className="mt-5" onClick={onCreate}><PlusIcon data-icon="inline-start" />{t.start}</Button></div></section>
}

function ThreadConversation({ sdk, language, onCreate }: { sdk: AuthMiniApi; language: Language; onCreate: () => void }) {
  const { threadId = "" } = useParams()
  const navigate = useNavigate()
  const client = useQueryClient()
  const t = copy[language]
  const thread = useQuery({ queryKey: ["thread", threadId], queryFn: () => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`), refetchInterval: 1500, enabled: Boolean(threadId) })
  const history = useQuery({ queryKey: ["history", threadId], queryFn: () => api<HistoryRecord[]>(sdk, `/api/threads/${encodeURIComponent(threadId)}/history`), refetchInterval: thread.data?.status === "running" ? 1200 : 2500, enabled: Boolean(threadId) })
  const [input, setInput] = useState("")
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => { setTitle(thread.data?.title ?? ""); setEditing(false) }, [threadId, thread.data?.title])
  const turn = useMutation({
    mutationFn: (value: string) => api<Run>(sdk, `/api/threads/${encodeURIComponent(threadId)}/turn`, { method: "POST", body: JSON.stringify({ input: value }) }),
    onSuccess: () => { setInput(""); void client.invalidateQueries({ queryKey: ["history", threadId] }); void client.invalidateQueries({ queryKey: ["thread", threadId] }); void client.invalidateQueries({ queryKey: ["threads"] }) },
  })
  const rename = useMutation({ mutationFn: (nextTitle: string) => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify({ title: nextTitle }) }), onSuccess: () => { setEditing(false); void client.invalidateQueries({ queryKey: ["thread", threadId] }); void client.invalidateQueries({ queryKey: ["threads"] }) } })
  const remove = useMutation({ mutationFn: () => api<unknown>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }), onSuccess: () => { setDeleteOpen(false); void client.invalidateQueries({ queryKey: ["threads"] }); navigate("/threads") } })
  if (thread.isLoading) return <div className="flex flex-1 flex-col gap-3 p-5"><Skeleton className="h-8 w-56" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
  if (thread.isError || !thread.data) return <div className="p-4"><RequestError language={language} error={thread.error} onRetry={() => void thread.refetch()} /></div>
  const current = thread.data
  return <section className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
      {editing ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (title.trim()) rename.mutate(title) }}><Input aria-label={t.threadName} value={title} onChange={(event) => setTitle(event.target.value)} /><Button size="sm" disabled={rename.isPending}>{rename.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{t.rename}</Button></form> : <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold">{current.title}</h1><p className="truncate text-xs text-muted-foreground">{current.model}</p></div>}
      <Badge variant={current.status === "failed" ? "destructive" : current.status === "running" ? "secondary" : "outline"}>{statusLabel(language, current.status)}</Badge>
      {!editing && <Button variant="ghost" size="icon-sm" aria-label={t.rename} onClick={() => setEditing(true)}><PencilIcon /></Button>}
      <Button variant="ghost" size="icon-sm" aria-label={t.delete} onClick={() => setDeleteOpen(true)}><Trash2Icon /></Button>
    </div>
    {turn.error && <div className="shrink-0 p-3"><RequestError language={language} error={turn.error} onRetry={() => turn.mutate(input)} /></div>}
    <MessageScrollerProvider autoScroll defaultScrollPosition="end"><MessageScroller className="min-h-0 flex-1"><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
      {history.isLoading && <div className="flex flex-col gap-3"><Skeleton className="h-18" /><Skeleton className="ml-auto h-18 w-4/5" /></div>}
      {history.error && <RequestError language={language} error={history.error} onRetry={() => void history.refetch()} />}
      {history.data?.map((record) => <MessageScrollerItem key={record.id}><HistoryMessage language={language} record={record} /></MessageScrollerItem>)}
      {!history.isLoading && !history.error && history.data?.length === 0 && <ThreadEmpty language={language} onCreate={onCreate} />}
      <MessageScrollerItem scrollAnchor />
    </MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" /></MessageScroller></MessageScrollerProvider>
    <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); const value = input.trim(); if (value && !turn.isPending) turn.mutate(value) }}><FieldGroup><Field><FieldLabel className="sr-only" htmlFor="thread-input">{t.input}</FieldLabel><Textarea id="thread-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t.input} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); const value = input.trim(); if (value && !turn.isPending) turn.mutate(value) } }} disabled={turn.isPending} /></Field><div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter</span><Button disabled={!input.trim() || turn.isPending}>{turn.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t.send}</Button></div></FieldGroup></form>
    <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>{t.deleteTitle}</DialogTitle><DialogDescription>{t.deleteDescription}</DialogDescription></DialogHeader>{remove.error && <RequestError language={language} error={remove.error} onRetry={() => remove.mutate()} />}<DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>{t.cancel}</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}{t.delete}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}

function HistoryMessage({ language, record }: { language: Language; record: HistoryRecord }) {
  const t = copy[language]
  const own = record.role === "user"
  const role = own ? t.user : record.role === "assistant" ? t.assistant : record.role === "tool" ? t.worker : t.system
  return <Message align={own ? "end" : "start"}><MessageAvatar aria-hidden="true">{role.slice(0, 1)}</MessageAvatar><MessageContent><MessageHeader>{role}</MessageHeader><MessageGroup><div className={own ? "max-w-[75ch] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground" : record.role === "system" ? "max-w-[75ch] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm leading-6 text-muted-foreground" : "max-w-[75ch] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm leading-6"}>{record.content}</div></MessageGroup><MessageFooter>{formattedTime(language, record.created_at)}</MessageFooter></MessageContent></Message>
}

function statusLabel(language: Language, status: Thread["status"]) { const t = copy[language]; return status === "running" ? t.running : status === "failed" ? t.failed : t.idle }

function CreateThreadDialog({ language, open, pending, error, onClose, onCreate }: { language: Language; open: boolean; pending: boolean; error: unknown; onClose: () => void; onCreate: (title: string) => void }) {
  const t = copy[language]
  const [title, setTitle] = useState("")
  useEffect(() => { if (!open) setTitle("") }, [open])
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); onCreate(title.trim() || "Untitled thread") }}><DialogHeader><DialogTitle>{t.newThread}</DialogTitle><DialogDescription>{t.emptyDescription}</DialogDescription></DialogHeader><FieldGroup className="py-2"><Field><FieldLabel htmlFor="thread-title">{t.threadName}</FieldLabel><Input id="thread-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t.threadName} /></Field></FieldGroup>{Boolean(error) && <RequestError language={language} error={error} onRetry={() => onCreate(title.trim() || "Untitled thread")} />}<DialogFooter><Button type="button" variant="outline" onClick={onClose}>{t.cancel}</Button><Button disabled={pending}>{pending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}{t.create}</Button></DialogFooter></form></DialogContent></Dialog>
}

function ApiKeysDialog({ sdk, language, open, onClose }: { sdk: AuthMiniApi; language: Language; open: boolean; onClose: () => void }) {
  const t = copy[language]
  const client = useQueryClient()
  const [label, setLabel] = useState("")
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => api<ApiKey[]>(sdk, "/api/api-keys"), enabled: open })
  const create = useMutation({ mutationFn: (value: string) => api<CreatedApiKey>(sdk, "/api/api-keys", { method: "POST", body: JSON.stringify({ label: value }) }), onSuccess: (key) => { setCreated(key); setLabel(""); void client.invalidateQueries({ queryKey: ["api-keys"] }) } })
  const revoke = useMutation({ mutationFn: (id: string) => api<unknown>(sdk, `/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: ["api-keys"] }) })
  return <Dialog open={open} onOpenChange={(next) => { if (!next) { setCreated(null); onClose() } }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t.apiTitle}</DialogTitle><DialogDescription>{t.apiDescription}</DialogDescription></DialogHeader><form className="border-y py-3" onSubmit={(event) => { event.preventDefault(); if (label.trim()) create.mutate(label.trim()) }}><FieldGroup><Field><FieldLabel htmlFor="api-key-label">{t.apiKeyLabel}</FieldLabel><div className="flex gap-2"><Input id="api-key-label" value={label} onChange={(event) => setLabel(event.target.value)} /><Button disabled={!label.trim() || create.isPending}>{create.isPending ? <Spinner /> : <KeyRoundIcon data-icon="inline-start" />}{t.createKey}</Button></div></Field></FieldGroup></form>{created && <Alert><KeyRoundIcon /><AlertTitle>{t.copyNow}</AlertTitle><AlertDescription className="flex flex-col gap-2"><span>{t.keyWarning}</span><SecretValue value={created.secret} /></AlertDescription></Alert>}{create.error && <RequestError language={language} error={create.error} onRetry={() => label.trim() && create.mutate(label.trim())} />}<div className="max-h-60 overflow-y-auto"><div className="flex flex-col divide-y">{keys.isLoading && <div className="p-3"><Skeleton className="h-8" /></div>}{keys.data?.map((key) => <div className="flex items-center gap-3 py-3" key={key.id}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{key.label}</p><p className="text-xs text-muted-foreground">{key.prefix}… · {formattedTime(language, key.created_at)}</p></div><Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(key.id)}><Trash2Icon data-icon="inline-start" />{t.revoke}</Button></div>)}{!keys.isLoading && keys.data?.length === 0 && <p className="py-5 text-sm text-muted-foreground">{t.noKeys}</p>}</div></div><DialogFooter><Button variant="outline" onClick={onClose}>{t.close}</Button></DialogFooter></DialogContent></Dialog>
}

function WorkersDialog({ sdk, language, open, onClose }: { sdk: AuthMiniApi; language: Language; open: boolean; onClose: () => void }) {
  const t = copy[language]
  const client = useQueryClient()
  const [label, setLabel] = useState("")
  const [pairing, setPairing] = useState<WorkerPairing | null>(null)
  const workers = useQuery({ queryKey: ["workers"], queryFn: () => api<Worker[]>(sdk, "/api/workers"), enabled: open, refetchInterval: open ? 5000 : false })
  const pair = useMutation({ mutationFn: (value: string) => api<WorkerPairing>(sdk, "/api/workers", { method: "POST", body: JSON.stringify({ label: value }) }), onSuccess: (value) => { setPairing(value); setLabel(""); void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const remove = useMutation({ mutationFn: (id: string) => api<unknown>(sdk, `/api/workers/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: ["workers"] }) })
  return <Dialog open={open} onOpenChange={(next) => { if (!next) { setPairing(null); onClose() } }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t.workersTitle}</DialogTitle><DialogDescription>{t.workersDescription}</DialogDescription></DialogHeader><form className="border-y py-3" onSubmit={(event) => { event.preventDefault(); if (label.trim()) pair.mutate(label.trim()) }}><FieldGroup><Field><FieldLabel htmlFor="worker-label">{t.workerName}</FieldLabel><div className="flex gap-2"><Input id="worker-label" value={label} onChange={(event) => setLabel(event.target.value)} /><Button disabled={!label.trim() || pair.isPending}>{pair.isPending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}{t.pair}</Button></div></Field></FieldGroup></form>{pairing && <Alert><MonitorCogIcon /><AlertTitle>{t.copyConfig}</AlertTitle><AlertDescription><SecretValue value={workerToml(pairing)} /></AlertDescription></Alert>}{pair.error && <RequestError language={language} error={pair.error} onRetry={() => label.trim() && pair.mutate(label.trim())} />}<div className="max-h-56 overflow-y-auto"><div className="flex flex-col divide-y">{workers.data?.map((worker) => <div className="flex items-center gap-3 py-3" key={worker.id}><StatusDot status={worker.status === "online" ? "running" : "idle"} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{worker.label}</p><p className="text-xs text-muted-foreground">{worker.last_seen_at ? formattedTime(language, worker.last_seen_at) : formattedTime(language, worker.created_at)}</p></div><Badge variant={worker.status === "online" ? "secondary" : "outline"}>{worker.status === "online" ? t.online : t.offline}</Badge><Button size="icon-sm" variant="ghost" aria-label={t.remove} disabled={remove.isPending} onClick={() => remove.mutate(worker.id)}><Trash2Icon /></Button></div>)}{!workers.isLoading && workers.data?.length === 0 && <p className="py-5 text-sm text-muted-foreground">{t.noWorkers}</p>}</div></div><DialogFooter><Button variant="outline" onClick={onClose}>{t.close}</Button></DialogFooter></DialogContent></Dialog>
}

function workerToml(pairing: WorkerPairing) { return `controller_url = "${pairing.controller_url}"\ntenant_id = "${pairing.tenant_id}"\nmachine_id = "${pairing.machine_id}"\naccess_token = "${pairing.access_token}"\n` }

function SecretValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="flex items-start gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-foreground">{value}</code><Button size="icon-sm" variant="outline" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button></div>
}

function RequestError({ language, error, onRetry }: { language: Language; error: unknown; onRetry: () => void }) {
  const t = copy[language]
  return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t.loadError}</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span>{errorMessage(error)}</span><Button size="sm" variant="outline" onClick={onRetry}>{t.retry}</Button></AlertDescription></Alert>
}

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><HashRouter><App /></HashRouter></QueryClientProvider></StrictMode>)
