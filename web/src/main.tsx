import { StrictMode, createContext, useContext, useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  HashRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom"
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { AuthMiniProvider, useAuthMini } from "auth-mini-react-components"
import type { AuthMiniApi } from "auth-mini/sdk/browser"
import { LinkitMyInfo, LinkitProvider } from "linkit-react-components"
import {
  ActivityIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  DatabaseIcon,
  FileKey2Icon,
  LanguagesIcon,
  MoonIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Settings2Icon,
  SunIcon,
  TerminalSquareIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"

import "./styles.css"
import "linkit-react-components/styles.css"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorBoundary, ErrorBoundaryFallback } from "@/components/error-boundary"
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
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"

type Language = "en" | "zh"
type ThreadStatus = "idle" | "running" | "failed"
type Thread = {
  id: string
  title: string
  model: string
  status: ThreadStatus
  created_at: number
  updated_at: number
}
type HistoryRecord = {
  id: number
  thread_id: string
  role: "user" | "assistant" | "tool" | "system"
  content: string
  created_at: number
}
type Run = {
  id: string
  thread_id: string
  status: "queued" | "running" | "completed" | "failed"
  error?: string | null
  started_at: number
  finished_at?: number | null
}
type ApiKey = {
  id: string
  label: string
  prefix: string
  created_at: number
  last_used_at?: number | null
}
type CreatedApiKey = ApiKey & { secret: string }
type Worker = {
  id: string
  label: string
  created_at: number
  last_seen_at?: number | null
  status: "online" | "offline"
  resource?: Record<string, unknown> | null
}
type WorkerPairing = {
  controller_url: string
  tenant_id: string
  machine_id: string
  access_token: string
}
type ReasoningAudit = {
  id: number
  run_id: string
  thread_id: string
  thread_title: string
  request_kind: string
  model: string
  status: "in_flight" | "completed" | "failed" | "cancelled"
  started_at: number
  finished_at: number | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  openai_lb_request_id: string | null
  error: string | null
}
type ReasoningAuditPage = {
  items: ReasoningAudit[]
  total: number
  page: number
  page_size: number
}
type IntegrationStatus = {
  openai_configured: boolean
  openai_consumer_id: string | null
  openai_base_url: string
  linkit_configured: boolean
  linkit_bot_id: string | null
  linkit_username: string | null
}
type SystemResources = {
  generated_at: number
  version: string
  process_id: number
  tenant_id: string
  database_bytes: number
  threads: number
  active_runs: number
  workers: number
  online_workers: number
}

const copy = {
  en: {
    threads: "Threads",
    newThread: "New thread",
    threadName: "Thread name",
    create: "Create",
    cancel: "Cancel",
    emptyTitle: "No threads yet",
    emptyDescription: "Start a focused thread. Every thread has its own history and run state.",
    chat: "Thread",
    send: "Send",
    input: "Give this thread its next instruction…",
    running: "Running",
    idle: "Idle",
    failed: "Failed",
    queued: "Queued",
    rename: "Rename",
    delete: "Delete",
    deleteTitle: "Delete this thread?",
    deleteDescription: "Its history, runs, Worker calls, and files for this thread will be removed.",
    api: "API keys",
    apiTitle: "Integration API",
    apiDescription: "Create a tenant-scoped key for another application to create threads and append inputs.",
    apiKeyLabel: "Key label",
    createKey: "Create API key",
    copyNow: "Copy this key now",
    keyWarning: "This secret is shown only once.",
    revoke: "Revoke",
    noKeys: "No API keys yet.",
    workers: "Workers",
    workersTitle: "Cybion Worker",
    workersDescription: "Pair a personal device so a thread can run approved local tools.",
    workerName: "Worker name",
    pair: "Create pairing",
    copyConfig: "Copy worker.toml",
    noWorkers: "No Workers paired.",
    online: "Online",
    offline: "Offline",
    remove: "Remove",
    theme: "Theme",
    language: "Language",
    light: "Light",
    dark: "Dark",
    menu: "Open navigation",
    model: "Model",
    updated: "Updated",
    start: "Start a thread",
    loadError: "Could not load this surface",
    retry: "Retry",
    system: "System",
    assistant: "Cybion",
    user: "You",
    worker: "Worker",
    close: "Close",
    navWork: "Work",
    navAudit: "Audit",
    navSystem: "System",
    navConfiguration: "Configuration",
    audit: "Reasoning audit",
    auditDescription: "Every model request, including in-flight work, with its final outcome.",
    auditStatus: "Status",
    auditAll: "All statuses",
    auditInFlight: "In flight",
    auditCompleted: "Completed",
    auditFailed: "Failed",
    auditCancelled: "Cancelled",
    auditThread: "Thread",
    auditRequest: "Request",
    auditStarted: "Started",
    auditFinished: "Finished",
    auditUsage: "Usage",
    auditLink: "OpenAI LB request",
    auditEmpty: "No reasoning requests yet.",
    auditRange: "{from}–{to} of {total} requests",
    previous: "Previous",
    next: "Next",
    pageSize: "Per page",
    systemTitle: "System",
    systemDescription: "Live runtime and tenant capacity for this Cybion workspace.",
    process: "Process",
    database: "Tenant database",
    activeRuns: "Active runs",
    workerCount: "Workers",
    tenant: "Tenant",
    sampled: "Sampled",
    configuration: "Configuration",
    configurationDescription: "External integrations and workspace-owned access surfaces.",
    integration: "Integrations",
    refreshIntegrations: "Provision or refresh integrations",
    refreshing: "Refreshing…",
    openai: "OpenAI-LB",
    linkit: "Linkit",
    configured: "Configured",
    notConfigured: "Not configured",
    baseUrl: "Base URL",
    username: "Username",
    tools: "Tools",
    toolsDescription: "Capabilities available to a paired Worker.",
    toolBash: "Run shell commands",
    toolBrowser: "Control a browser",
    toolComputer: "Control the desktop",
    history: "History",
    historyDescription: "Choose a thread to inspect its durable conversation history.",
    noHistory: "No messages in this thread yet.",
    connection: "Connected",
    hosted: "Hosted workspace",
    pageErrorTitle: "This page hit an unexpected error",
    pageErrorDescription: "The rest of the workspace is still available. Try again or reload the app.",
    appErrorTitle: "Cybion could not load",
    appErrorDescription: "Reload the app to restore your workspace.",
    errorDetails: "Error details",
    tryAgain: "Try again",
    reload: "Reload",
  },
  zh: {
    threads: "线程",
    newThread: "新建线程",
    threadName: "线程名称",
    create: "创建",
    cancel: "取消",
    emptyTitle: "还没有线程",
    emptyDescription: "创建一个聚焦的线程。每个线程都拥有独立的历史和运行状态。",
    chat: "线程",
    send: "发送",
    input: "为这个线程追加下一条指令…",
    running: "运行中",
    idle: "空闲",
    failed: "失败",
    queued: "排队中",
    rename: "重命名",
    delete: "删除",
    deleteTitle: "删除这个线程？",
    deleteDescription: "该线程的历史、运行、Worker 调用及文件都会被删除。",
    api: "API 密钥",
    apiTitle: "集成 API",
    apiDescription: "创建仅属于当前租户的密钥，让其他应用创建线程或追加输入。",
    apiKeyLabel: "Key 名称",
    createKey: "创建 API Key",
    copyNow: "立即复制此 Key",
    keyWarning: "密钥只会显示一次。",
    revoke: "撤销",
    noKeys: "还没有 API Key。",
    workers: "Worker",
    workersTitle: "Cybion Worker",
    workersDescription: "配对个人设备，让线程可以调用经过授权的本地工具。",
    workerName: "Worker 名称",
    pair: "创建配对",
    copyConfig: "复制 worker.toml",
    noWorkers: "还没有配对的 Worker。",
    online: "在线",
    offline: "离线",
    remove: "移除",
    theme: "主题",
    language: "语言",
    light: "浅色",
    dark: "深色",
    menu: "打开导航",
    model: "模型",
    updated: "更新时间",
    start: "创建线程",
    loadError: "无法加载这个页面",
    retry: "重试",
    system: "系统",
    assistant: "Cybion",
    user: "你",
    worker: "Worker",
    close: "关闭",
    navWork: "工作",
    navAudit: "审计",
    navSystem: "系统",
    navConfiguration: "配置",
    audit: "推理审计",
    auditDescription: "展示所有模型请求，包括在途请求及其最终结果。",
    auditStatus: "状态",
    auditAll: "全部状态",
    auditInFlight: "在途",
    auditCompleted: "已完成",
    auditFailed: "失败",
    auditCancelled: "已取消",
    auditThread: "线程",
    auditRequest: "请求",
    auditStarted: "发起时间",
    auditFinished: "结束时间",
    auditUsage: "用量",
    auditLink: "OpenAI LB 请求",
    auditEmpty: "尚无推理请求。",
    auditRange: "第 {from}–{to} 条，共 {total} 个请求",
    previous: "上一页",
    next: "下一页",
    pageSize: "每页",
    systemTitle: "系统",
    systemDescription: "当前 Cybion 工作区的实时运行状态与租户容量。",
    process: "进程",
    database: "租户数据库",
    activeRuns: "活动运行",
    workerCount: "Worker 数量",
    tenant: "租户",
    sampled: "采样时间",
    configuration: "配置",
    configurationDescription: "外部集成和当前工作区拥有的访问入口。",
    integration: "集成",
    refreshIntegrations: "开通或刷新集成",
    refreshing: "刷新中…",
    openai: "OpenAI-LB",
    linkit: "Linkit",
    configured: "已配置",
    notConfigured: "未配置",
    baseUrl: "基础地址",
    username: "用户名",
    tools: "工具",
    toolsDescription: "已配对 Worker 可使用的能力。",
    toolBash: "运行 Shell 命令",
    toolBrowser: "控制浏览器",
    toolComputer: "控制桌面",
    history: "历史",
    historyDescription: "选择一个线程查看它的持久对话历史。",
    noHistory: "这个线程还没有消息。",
    connection: "已连接",
    hosted: "托管工作区",
    pageErrorTitle: "这个页面遇到了意外错误",
    pageErrorDescription: "工作区的其他功能仍然可用。可以重试或重新加载应用。",
    appErrorTitle: "Cybion 无法加载",
    appErrorDescription: "重新加载应用即可恢复工作区。",
    errorDetails: "错误详情",
    tryAgain: "重试",
    reload: "重新加载",
  },
} as const

type CopyKey = keyof typeof copy.en
type UiContextValue = {
  language: Language
  setLanguage: (language: Language) => void
  dark: boolean
  toggleTheme: () => void
  t: (key: CopyKey) => string
}
const UiContext = createContext<UiContextValue | null>(null)

function useUi() {
  const value = useContext(UiContext)
  if (!value) throw new Error("UI context is missing")
  return value
}

const queryClient = new QueryClient()
const AUTH_AUDIENCES = ["cybion.ntnl.io", "linkit.ntnl.io", "openai.ntnl.io"] as const

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed"
}

function callbackUrl() {
  return `${location.origin}${location.pathname}#/auth/callback`
}

function formattedTime(language: Language, value: number | null | undefined) {
  if (!value) return "—"
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value * 1000)
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

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
  const request = async (token: string) => fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
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
  return <TooltipProvider delayDuration={0}>
    <AuthMiniProvider
      authMiniBaseUrl="https://auth.ntnl.io"
      audiences={AUTH_AUDIENCES}
      callbackUrl={callbackUrl()}
      autoRedirectToLogin
    >
      <AuthenticatedApp />
    </AuthMiniProvider>
  </TooltipProvider>
}

function AuthenticatedApp() {
  const { isReady, isAuthenticated, sdk } = useAuthMini()
  if (!isReady || !isAuthenticated || !sdk) return <LoadingScreen />
  return <Workspace sdk={sdk} />
}

function LoadingScreen() {
  return <main className="flex min-h-svh items-center justify-center bg-background">
    <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Cybion</div>
  </main>
}

type WorkspaceNavItem = { to: string; label: string; icon: typeof TerminalSquareIcon }
type WorkspaceNavGroup = { id: string; label: string; items: WorkspaceNavItem[] }

function WorkspaceNav({ nav }: { nav: WorkspaceNavGroup[] }) {
  const { setOpenMobile } = useSidebar()
  return <>
    {nav.map(({ id, label, items }) => <SidebarGroup key={id}>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(({ to, label: itemLabel, icon: Icon }) => <SidebarMenuItem key={to}>
            <SidebarMenuButton asChild tooltip={itemLabel}>
              <NavLink
                to={to}
                onClick={() => setOpenMobile(false)}
                className={({ isActive }) => isActive ? "font-medium" : ""}
              >
                <Icon /><span>{itemLabel}</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>)}
  </>
}

function Workspace({ sdk }: { sdk: AuthMiniApi }) {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem("cybion.language") === "zh" ? "zh" : "en")
  const [dark, setDark] = useState(() => localStorage.getItem("cybion.theme") === "dark" || (!localStorage.getItem("cybion.theme") && matchMedia("(prefers-color-scheme: dark)").matches))
  const [createOpen, setCreateOpen] = useState(false)
  const labels = copy[language]
  const client = useQueryClient()
  const threads = useQuery({
    queryKey: ["threads"],
    queryFn: () => api<Thread[]>(sdk, "/api/threads"),
    refetchInterval: 2000,
  })
  const createThread = useMutation({
    mutationFn: (title: string) => api<Thread>(sdk, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
    onSuccess: (thread) => {
      void client.invalidateQueries({ queryKey: ["threads"] })
      setCreateOpen(false)
      location.hash = `#/threads/${thread.id}`
    },
  })
  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en"
    localStorage.setItem("cybion.language", language)
  }, [language])
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("cybion.theme", dark ? "dark" : "light")
  }, [dark])
  const ui = useMemo<UiContextValue>(() => ({
    language,
    setLanguage,
    dark,
    toggleTheme: () => setDark((current) => !current),
    t: (key) => copy[language][key],
  }), [dark, language])
  return <LinkitProvider linkitBaseUrl="https://linkit.ntnl.io" lang={language === "zh" ? "zh-CN" : "en-US"}>
    <UiContext.Provider value={ui}>
      <ErrorBoundary fallback={({ error, reset }) => <ErrorBoundaryFallback
        error={error}
        reset={reset}
        title={labels.appErrorTitle}
        description={labels.appErrorDescription}
        detailsLabel={labels.errorDetails}
        retryLabel={labels.tryAgain}
        reloadLabel={labels.reload}
      />}>
        <WorkspaceShell
          sdk={sdk}
          threads={threads.data ?? []}
          threadsLoading={threads.isLoading}
          threadsError={threads.error}
          onCreate={() => setCreateOpen(true)}
        />
      </ErrorBoundary>
      <ErrorBoundary fallback={({ error, reset }) => <ErrorBoundaryFallback
        error={error}
        reset={reset}
        title={labels.pageErrorTitle}
        description={labels.pageErrorDescription}
        detailsLabel={labels.errorDetails}
        retryLabel={labels.tryAgain}
        reloadLabel={labels.reload}
      />}>
        <CreateThreadDialog
          language={language}
          open={createOpen}
          pending={createThread.isPending}
          error={createThread.error}
          onClose={() => setCreateOpen(false)}
          onCreate={(title) => createThread.mutate(title)}
        />
      </ErrorBoundary>
    </UiContext.Provider>
  </LinkitProvider>
}

function WorkspaceShell({
  sdk,
  threads,
  threadsLoading,
  threadsError,
  onCreate,
}: {
  sdk: AuthMiniApi
  threads: Thread[]
  threadsLoading: boolean
  threadsError: unknown
  onCreate: () => void
}) {
  const { language, dark, toggleTheme, setLanguage, t } = useUi()
  const location = useLocation()
  const routeTitle = pageTitle(location.pathname, t)
  const workNav = [
    { to: "/threads", label: t("threads"), icon: TerminalSquareIcon },
  ]
  const auditNav = [
    { to: "/reasoning-audit", label: t("audit"), icon: ActivityIcon },
    { to: "/history", label: t("history"), icon: DatabaseIcon },
  ]
  const systemNav = [
    { to: "/system", label: t("systemTitle"), icon: NetworkIcon },
    { to: "/workers", label: t("workers"), icon: NetworkIcon },
  ]
  const configurationNav = [
    { to: "/configuration", label: t("configuration"), icon: Settings2Icon },
    { to: "/api", label: t("api"), icon: FileKey2Icon },
    { to: "/tools", label: t("tools"), icon: WrenchIcon },
  ]
  const nav: WorkspaceNavGroup[] = [
    { id: "work", label: t("navWork"), items: workNav },
    { id: "audit", label: t("navAudit"), items: auditNav },
    { id: "system", label: t("navSystem"), items: systemNav },
    { id: "configuration", label: t("navConfiguration"), items: configurationNav },
  ]
  return <SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2.5 px-2 py-1 font-heading text-lg font-semibold">
          <img alt="" aria-hidden="true" className="size-6 shrink-0 dark:invert" src="/cybion-mark.png" />
          <span className="group-data-[collapsible=icon]:hidden">Cybion</span>
        </div>
      </SidebarHeader>
      <SidebarContent><WorkspaceNav nav={nav} /></SidebarContent>
      <SidebarFooter>
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground group-data-[collapsible=icon]:justify-center">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="group-data-[collapsible=icon]:hidden">{t("hosted")}</span>
        </div>
      </SidebarFooter>
    </Sidebar>
    <SidebarInset className="h-svh overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
        <SidebarTrigger aria-label={t("menu")} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{routeTitle}</p>
          {threadsLoading && <p className="sr-only">{t("threads")}</p>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={t("language")} onClick={() => setLanguage(language === "en" ? "zh" : "en")}>
            <LanguagesIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t("theme")} onClick={toggleTheme}>
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
          <LinkitMyInfo />
        </div>
      </header>
      {Boolean(threadsError) && location.pathname.startsWith("/threads") && <div className="p-4"><RequestError error={threadsError} /></div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary
          resetKeys={[location.pathname]}
          fallback={({ error, reset }) => <ErrorBoundaryFallback
            error={error}
            reset={reset}
            title={t("pageErrorTitle")}
            description={t("pageErrorDescription")}
            detailsLabel={t("errorDetails")}
            retryLabel={t("tryAgain")}
            reloadLabel={t("reload")}
          />}
        >
          <Routes>
            <Route path="/threads" element={<ThreadsPage threads={threads} loading={threadsLoading} error={threadsError} onCreate={onCreate} />} />
            <Route path="/threads/:threadId" element={<ThreadConversation sdk={sdk} threads={threads} onCreate={onCreate} />} />
            <Route path="/reasoning-audit" element={<ReasoningAuditPage sdk={sdk} />} />
            <Route path="/history" element={<HistoryPage threads={threads} />} />
            <Route path="/system" element={<SystemPage sdk={sdk} />} />
            <Route path="/resources" element={<SystemPage sdk={sdk} />} />
            <Route path="/workers" element={<WorkersPage sdk={sdk} />} />
            <Route path="/configuration" element={<ConfigurationPage sdk={sdk} />} />
            <Route path="/settings" element={<ConfigurationPage sdk={sdk} />} />
            <Route path="/api" element={<ApiKeysPage sdk={sdk} />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="*" element={<Navigate to="/threads" replace />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </SidebarInset>
  </SidebarProvider>
}

function pageTitle(pathname: string, t: (key: CopyKey) => string) {
  if (pathname.startsWith("/reasoning-audit")) return t("audit")
  if (pathname.startsWith("/history")) return t("history")
  if (pathname.startsWith("/system") || pathname.startsWith("/resources")) return t("systemTitle")
  if (pathname.startsWith("/workers")) return t("workers")
  if (pathname.startsWith("/configuration") || pathname.startsWith("/settings")) return t("configuration")
  if (pathname.startsWith("/api")) return t("api")
  if (pathname.startsWith("/tools")) return t("tools")
  return t("threads")
}

function ThreadsPage({ threads, loading, error, onCreate }: { threads: Thread[]; loading: boolean; error: unknown; onCreate: () => void }) {
  const { t } = useUi()
  return <Page title={t("threads")} description={t("emptyDescription")}>
    <div className="grid gap-4 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
      <Card className="min-h-[24rem]">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div><CardTitle>{t("threads")}</CardTitle><CardDescription>{t("hosted")}</CardDescription></div>
          <Button size="icon-sm" aria-label={t("newThread")} onClick={onCreate}><PlusIcon /></Button>
        </CardHeader>
        <CardContent className="min-h-0 p-2">
          {Boolean(error) && <RequestError error={error} />}
          {loading && <div className="flex flex-col gap-2 p-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
          {!loading && threads.length === 0 && <div className="p-3 text-sm text-muted-foreground">{t("emptyTitle")}</div>}
          {!loading && threads.map((thread) => <ThreadLink key={thread.id} thread={thread} />)}
        </CardContent>
      </Card>
      <Card className="flex min-h-[24rem] items-center justify-center">
        <CardContent className="max-w-md text-center">
          <h2 className="text-lg font-semibold">{t("emptyTitle")}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("emptyDescription")}</p>
          <Button className="mt-5" onClick={onCreate}><PlusIcon data-icon="inline-start" />{t("start")}</Button>
        </CardContent>
      </Card>
    </div>
  </Page>
}

function ThreadLink({ thread }: { thread: Thread }) {
  const { t } = useUi()
  return <Link to={`/threads/${thread.id}`} className="flex min-w-0 items-center gap-2 rounded-md px-3 py-2.5 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <StatusDot status={thread.status} />
    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
    <span className="sr-only">{statusLabel(thread.status, t)}</span>
  </Link>
}

function StatusDot({ status }: { status: ThreadStatus }) {
  return <span aria-hidden="true" className={status === "running" ? "size-2 shrink-0 rounded-full bg-primary" : status === "failed" ? "size-2 shrink-0 rounded-full bg-destructive" : "size-2 shrink-0 rounded-full bg-muted-foreground/45"} />
}

function statusLabel(status: ThreadStatus, t: (key: CopyKey) => string) {
  return status === "running" ? t("running") : status === "failed" ? t("failed") : t("idle")
}

function ThreadConversation({ sdk, threads, onCreate }: { sdk: AuthMiniApi; threads: Thread[]; onCreate: () => void }) {
  const { threadId = "" } = useParams()
  const { t, language } = useUi()
  const navigate = useNavigate()
  const client = useQueryClient()
  const thread = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`),
    refetchInterval: 1500,
    enabled: Boolean(threadId),
  })
  const history = useQuery({
    queryKey: ["history", threadId],
    queryFn: () => api<HistoryRecord[]>(sdk, `/api/threads/${encodeURIComponent(threadId)}/history`),
    refetchInterval: thread.data?.status === "running" ? 1200 : 2500,
    enabled: Boolean(threadId),
  })
  const [input, setInput] = useState("")
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    setTitle(thread.data?.title ?? "")
    setEditing(false)
  }, [threadId, thread.data?.title])
  const turn = useMutation({
    mutationFn: (value: string) => api<Run>(sdk, `/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      body: JSON.stringify({ input: value }),
    }),
    onSuccess: () => {
      setInput("")
      void client.invalidateQueries({ queryKey: ["history", threadId] })
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["reasoning-audits"] })
    },
  })
  const rename = useMutation({
    mutationFn: (nextTitle: string) => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title: nextTitle }),
    }),
    onSuccess: () => {
      setEditing(false)
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const remove = useMutation({
    mutationFn: () => api<unknown>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleteOpen(false)
      void client.invalidateQueries({ queryKey: ["threads"] })
      navigate("/threads")
    },
  })
  if (thread.isLoading) return <Page title={t("chat")} description=""><div className="flex flex-col gap-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div></Page>
  if (thread.isError || !thread.data) return <Page title={t("chat")} description=""><RequestError error={thread.error} /></Page>
  const current = thread.data
  return <main className="flex min-h-full flex-col lg:flex-row">
    <aside className="border-b bg-sidebar/40 p-3 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <p className="text-xs font-medium text-muted-foreground">{t("threads")}</p>
        <Button size="icon-sm" variant="ghost" aria-label={t("newThread")} onClick={onCreate}><PlusIcon /></Button>
      </div>
      <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-9rem)]" aria-label={t("threads")}>
        {threads.map((item) => <ThreadLink key={item.id} thread={item} />)}
      </nav>
    </aside>
    <section className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        {editing ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (title.trim()) rename.mutate(title.trim()) }}>
          <Input aria-label={t("threadName")} value={title} onChange={(event) => setTitle(event.target.value)} />
          <Button size="sm" disabled={rename.isPending}>{rename.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{t("rename")}</Button>
        </form> : <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold">{current.title}</h1><p className="truncate text-xs text-muted-foreground">{current.model}</p></div>}
        <Badge variant={current.status === "failed" ? "destructive" : current.status === "running" ? "secondary" : "outline"}>{statusLabel(current.status, t)}</Badge>
        {!editing && <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{t("rename")}</Button>}
        <Button variant="ghost" size="icon-sm" aria-label={t("delete")} onClick={() => setDeleteOpen(true)}><Trash2Icon /></Button>
      </div>
      {turn.error && <div className="shrink-0 p-3"><RequestError error={turn.error} onRetry={() => input.trim() && turn.mutate(input.trim())} /></div>}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
              {history.isLoading && <div className="flex flex-col gap-3"><Skeleton className="h-18" /><Skeleton className="ml-auto h-18 w-4/5" /></div>}
              {history.error && <RequestError error={history.error} onRetry={() => void history.refetch()} />}
              {history.data?.map((record) => <MessageScrollerItem key={record.id}><HistoryMessage language={language} record={record} /></MessageScrollerItem>)}
              {!history.isLoading && !history.error && history.data?.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">{t("noHistory")}</div>}
              {current.status === "running" && <MessageScrollerItem><div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("running")}</div></MessageScrollerItem>}
              <MessageScrollerItem scrollAnchor />
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton behavior="auto" />
        </MessageScroller>
      </MessageScrollerProvider>
      <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); const value = input.trim(); if (value && !turn.isPending) turn.mutate(value) }}>
        <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="thread-input">{t("input")}</FieldLabel><Textarea id="thread-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("input")} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); const value = input.trim(); if (value && !turn.isPending) turn.mutate(value) } }} disabled={turn.isPending} /></Field>
          <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter</span><Button disabled={!input.trim() || turn.isPending}>{turn.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t("send")}</Button></div>
        </FieldGroup>
      </form>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>{t("deleteTitle")}</DialogTitle><DialogDescription>{t("deleteDescription")}</DialogDescription></DialogHeader>{remove.error && <RequestError error={remove.error} onRetry={() => remove.mutate()} />}<DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("cancel")}</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}{t("delete")}</Button></DialogFooter></DialogContent></Dialog>
    </section>
  </main>
}

function HistoryMessage({ language, record }: { language: Language; record: HistoryRecord }) {
  const { t } = useUi()
  const own = record.role === "user"
  const role = own ? t("user") : record.role === "assistant" ? t("assistant") : record.role === "tool" ? t("worker") : t("system")
  return <Message align={own ? "end" : "start"}><MessageAvatar aria-hidden="true">{role.slice(0, 1)}</MessageAvatar><MessageContent><MessageHeader>{role}</MessageHeader><MessageGroup><div className={own ? "max-w-[75ch] whitespace-pre-wrap break-words rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground" : record.role === "system" ? "max-w-[75ch] whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm leading-6 text-muted-foreground" : "max-w-[75ch] whitespace-pre-wrap break-words rounded-lg border bg-card px-3 py-2 text-sm leading-6"}>{record.content}</div></MessageGroup><MessageFooter>{formattedTime(language, record.created_at)}</MessageFooter></MessageContent></Message>
}

function ReasoningAuditPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const [status, setStatus] = useState<ReasoningAudit["status"] | "all">("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const query = useQuery({
    queryKey: ["reasoning-audits", status, page, pageSize],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (status !== "all") params.set("status", status)
      return api<ReasoningAuditPage>(sdk, `/api/reasoning-audits?${params}`)
    },
    refetchInterval: 2000,
  })
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize))
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])
  const rangeStart = query.data?.total ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = query.data ? rangeStart + query.data.items.length - 1 : 0
  const range = t("auditRange").replace("{from}", String(rangeStart)).replace("{to}", String(rangeEnd)).replace("{total}", String(query.data?.total ?? 0))
  return <Page title={t("audit")} description={t("auditDescription")}>
    <Card><CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><CardTitle>{t("audit")}</CardTitle><CardDescription>{t("auditDescription")}</CardDescription></div><div className="flex items-center gap-2"><Select value={status} onValueChange={(value) => { setStatus(value as ReasoningAudit["status"] | "all"); setPage(1) }}><SelectTrigger aria-label={t("auditStatus")} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("auditAll")}</SelectItem><SelectItem value="in_flight">{t("auditInFlight")}</SelectItem><SelectItem value="completed">{t("auditCompleted")}</SelectItem><SelectItem value="failed">{t("auditFailed")}</SelectItem><SelectItem value="cancelled">{t("auditCancelled")}</SelectItem></SelectContent></Select><Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}><SelectTrigger aria-label={t("pageSize")} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent></Select></div></CardHeader><CardContent>
      {query.error && <RequestError error={query.error} onRetry={() => void query.refetch()} />}
      {!query.data && !query.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("audit")}</div>}
      {query.data && query.data.items.length === 0 && <p className="py-8 text-sm text-muted-foreground">{t("auditEmpty")}</p>}
      {query.data && query.data.items.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[50rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t("auditThread")}</th><th className="px-3 py-2 font-medium">{t("auditRequest")}</th><th className="px-3 py-2 font-medium">{t("auditStatus")}</th><th className="px-3 py-2 font-medium">{t("auditStarted")}</th><th className="px-3 py-2 font-medium">{t("auditFinished")}</th><th className="px-3 py-2 font-medium">{t("auditUsage")}</th><th className="px-3 py-2 font-medium">{t("auditLink")}</th></tr></thead><tbody className="divide-y">{query.data.items.map((item) => <tr key={item.id} className="align-top"><td className="max-w-56 px-3 py-3"><Link className="font-medium hover:underline" to={`/threads/${item.thread_id}`}>{item.thread_title || item.thread_id}</Link><p className="mt-1 truncate font-mono text-[0.7rem] text-muted-foreground">{item.thread_id}</p></td><td className="px-3 py-3"><code>{item.model}</code><p className="mt-1 text-xs text-muted-foreground">{item.request_kind}</p></td><td className="px-3 py-3"><Badge variant={item.status === "failed" ? "destructive" : item.status === "in_flight" ? "secondary" : "outline"}>{auditStatusLabel(item.status, t)}</Badge>{item.error && <p className="mt-2 max-w-64 break-words text-xs text-destructive">{item.error}</p>}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.started_at)}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.finished_at)}</td><td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">{usageLabel(item)}</td><td className="max-w-40 px-3 py-3">{item.openai_lb_request_id ? <code className="break-all text-xs">{item.openai_lb_request_id}</code> : <span className="text-xs text-muted-foreground">—</span>}</td></tr>)}</tbody></table></div>}
      {query.data && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{range}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t("previous")}</Button><Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>{t("next")}</Button></div></div>}
    </CardContent></Card>
  </Page>
}

function auditStatusLabel(status: ReasoningAudit["status"], t: (key: CopyKey) => string) {
  return status === "in_flight" ? t("auditInFlight") : status === "completed" ? t("auditCompleted") : status === "failed" ? t("auditFailed") : t("auditCancelled")
}

function usageLabel(item: ReasoningAudit) {
  if (item.input_tokens === null && item.output_tokens === null) return "—"
  return `${item.input_tokens ?? 0} in · ${item.output_tokens ?? 0} out${item.cached_tokens === null ? "" : ` · ${item.cached_tokens} cached`}`
}

function HistoryPage({ threads }: { threads: Thread[] }) {
  const { t, language } = useUi()
  return <Page title={t("history")} description={t("historyDescription")}><Card><CardHeader><CardTitle>{t("threads")}</CardTitle><CardDescription>{t("historyDescription")}</CardDescription></CardHeader><CardContent className="divide-y p-0">{threads.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("emptyTitle")}</p> : threads.map((thread) => <Link key={thread.id} to={`/threads/${thread.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-accent"><StatusDot status={thread.status} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{thread.title}</span><span className="text-xs text-muted-foreground">{formattedTime(language, thread.updated_at)}</span></Link>)}</CardContent></Card></Page>
}

function SystemPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const query = useQuery({ queryKey: ["system-resources"], queryFn: () => api<SystemResources>(sdk, "/api/system/resources"), refetchInterval: 5000 })
  return <Page title={t("systemTitle")} description={t("systemDescription")}>
    {query.error && <RequestError error={query.error} onRetry={() => void query.refetch()} />}
    {!query.data && !query.error && <Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t("systemTitle")}</CardContent></Card>}
    {query.data && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label={t("process")} value={`PID ${query.data.process_id}`} detail={`v${query.data.version}`} /><MetricCard label={t("database")} value={formatBytes(query.data.database_bytes)} detail={query.data.tenant_id} /><MetricCard label={t("activeRuns")} value={String(query.data.active_runs)} detail={t("running")} progress={query.data.active_runs ? 100 : 0} /><MetricCard label={t("workerCount")} value={`${query.data.online_workers} / ${query.data.workers}`} detail={t("online")} progress={query.data.workers ? query.data.online_workers / query.data.workers * 100 : 0} /><Card className="sm:col-span-2 xl:col-span-4"><CardHeader><CardTitle>{t("connection")}</CardTitle><CardDescription>{t("sampled")}: {formattedTime(language, query.data.generated_at)}</CardDescription></CardHeader><CardContent><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("tenant")}</dt><dd className="mt-1 break-all font-mono text-xs">{query.data.tenant_id}</dd></div><div><dt className="text-muted-foreground">{t("process")}</dt><dd className="mt-1">Cybion Cloud · {t("hosted")}</dd></div></dl></CardContent></Card></div>}
  </Page>
}

function MetricCard({ label, value, detail, progress }: { label: string; value: string; detail: string; progress?: number }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{detail}{progress !== undefined && <Progress className="mt-3" value={Math.max(0, Math.min(100, progress))} />}</CardContent></Card>
}

function ConfigurationPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t } = useUi()
  const client = useQueryClient()
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => api<IntegrationStatus>(sdk, "/api/integrations") })
  const refresh = useMutation({ mutationFn: () => api<IntegrationStatus>(sdk, "/api/integrations/refresh", { method: "POST" }), onSuccess: (value) => client.setQueryData(["integrations"], value) })
  return <Page title={t("configuration")} description={t("configurationDescription")}>
    <Card><CardHeader><CardTitle>{t("integration")}</CardTitle><CardDescription>{t("configurationDescription")}</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
      {integrations.error && <div className="sm:col-span-2"><RequestError error={integrations.error} onRetry={() => void integrations.refetch()} /></div>}
      {integrations.data && <><IntegrationRow label={t("openai")} configured={integrations.data.openai_configured} detail={integrations.data.openai_consumer_id ?? t("notConfigured")} /><IntegrationRow label={t("linkit")} configured={integrations.data.linkit_configured} detail={integrations.data.linkit_username ? `@${integrations.data.linkit_username}` : t("notConfigured")} /><div className="sm:col-span-2"><p className="text-xs text-muted-foreground">{t("baseUrl")}</p><code className="mt-1 block break-all text-sm">{integrations.data.openai_base_url}</code></div></>}
      {!integrations.data && !integrations.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("integration")}</div>}
      <div className="sm:col-span-2"><Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? <Spinner /> : <RefreshCwIcon data-icon="inline-start" />}{refresh.isPending ? t("refreshing") : t("refreshIntegrations")}</Button>{refresh.error && <p className="mt-2 text-sm text-destructive">{errorMessage(refresh.error)}</p>}</div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>{t("api")}</CardTitle><CardDescription>{t("apiDescription")}</CardDescription></CardHeader><CardContent><Button asChild variant="outline"><Link to="/api">{t("api")}</Link></Button></CardContent></Card>
    <Card><CardHeader><CardTitle>{t("workers")}</CardTitle><CardDescription>{t("workersDescription")}</CardDescription></CardHeader><CardContent><Button asChild variant="outline"><Link to="/workers">{t("workers")}</Link></Button></CardContent></Card>
  </Page>
}

function IntegrationRow({ label, configured, detail }: { label: string; configured: boolean; detail: string }) {
  const { t } = useUi()
  return <div className="flex min-w-0 items-start justify-between gap-3 rounded-lg border p-4"><div className="min-w-0"><p className="font-medium">{label}</p><p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p></div><Badge variant={configured ? "secondary" : "outline"}>{configured ? t("configured") : t("notConfigured")}</Badge></div>
}

function ApiKeysPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const client = useQueryClient()
  const [label, setLabel] = useState("")
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => api<ApiKey[]>(sdk, "/api/api-keys") })
  const create = useMutation({ mutationFn: (value: string) => api<CreatedApiKey>(sdk, "/api/api-keys", { method: "POST", body: JSON.stringify({ label: value }) }), onSuccess: (key) => { setCreated(key); setLabel(""); void client.invalidateQueries({ queryKey: ["api-keys"] }) } })
  const revoke = useMutation({ mutationFn: (id: string) => api<unknown>(sdk, `/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: ["api-keys"] }) })
  return <Page title={t("api")} description={t("apiDescription")}><Card><CardHeader><CardTitle>{t("createKey")}</CardTitle><CardDescription>{t("keyWarning")}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (label.trim()) create.mutate(label.trim()) }}><Input aria-label={t("apiKeyLabel")} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("apiKeyLabel")} /><Button disabled={!label.trim() || create.isPending}>{create.isPending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}{t("createKey")}</Button></form>{created && <Alert className="mt-4"><FileKey2Icon /><AlertTitle>{t("copyNow")}</AlertTitle><AlertDescription className="flex flex-col gap-2"><span>{t("keyWarning")}</span><SecretValue value={created.secret} /></AlertDescription></Alert>}{create.error && <p className="mt-3 text-sm text-destructive">{errorMessage(create.error)}</p>}</CardContent></Card><Card><CardHeader><CardTitle>{t("apiTitle")}</CardTitle></CardHeader><CardContent>{keys.error && <RequestError error={keys.error} onRetry={() => void keys.refetch()} />}{keys.isLoading && <Skeleton className="h-8" />}{keys.data && keys.data.length === 0 && <p className="text-sm text-muted-foreground">{t("noKeys")}</p>}{keys.data?.map((key) => <div className="flex items-center gap-3 border-b py-3 last:border-0" key={key.id}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{key.label}</p><p className="text-xs text-muted-foreground">{key.prefix}… · {formattedTime(language, key.created_at)}</p></div><Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(key.id)}><Trash2Icon data-icon="inline-start" />{t("revoke")}</Button></div>)}</CardContent></Card></Page>
}

function WorkersPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const client = useQueryClient()
  const [label, setLabel] = useState("")
  const [pairing, setPairing] = useState<WorkerPairing | null>(null)
  const workers = useQuery({ queryKey: ["workers"], queryFn: () => api<Worker[]>(sdk, "/api/workers"), refetchInterval: 5000 })
  const pair = useMutation({ mutationFn: (value: string) => api<WorkerPairing>(sdk, "/api/workers", { method: "POST", body: JSON.stringify({ label: value }) }), onSuccess: (value) => { setPairing(value); setLabel(""); void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const remove = useMutation({ mutationFn: (id: string) => api<unknown>(sdk, `/api/workers/${encodeURIComponent(id)}`, { method: "DELETE" }), onSuccess: () => void client.invalidateQueries({ queryKey: ["workers"] }) })
  return <Page title={t("workers")} description={t("workersDescription")}><Card><CardHeader><CardTitle>{t("pair")}</CardTitle><CardDescription>{t("workersDescription")}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (label.trim()) pair.mutate(label.trim()) }}><Input aria-label={t("workerName")} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("workerName")} /><Button disabled={!label.trim() || pair.isPending}>{pair.isPending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}{t("pair")}</Button></form>{pairing && <Alert className="mt-4"><NetworkIcon /><AlertTitle>{t("copyConfig")}</AlertTitle><AlertDescription><SecretValue value={workerToml(pairing)} /></AlertDescription></Alert>}{pair.error && <p className="mt-3 text-sm text-destructive">{errorMessage(pair.error)}</p>}</CardContent></Card><Card><CardHeader><CardTitle>{t("workers")}</CardTitle></CardHeader><CardContent>{workers.error && <RequestError error={workers.error} onRetry={() => void workers.refetch()} />}{workers.isLoading && <Skeleton className="h-8" />}{workers.data && workers.data.length === 0 && <p className="text-sm text-muted-foreground">{t("noWorkers")}</p>}{workers.data?.map((worker) => <div className="flex items-center gap-3 border-b py-3 last:border-0" key={worker.id}><StatusDot status={worker.status === "online" ? "running" : "idle"} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{worker.label}</p><p className="text-xs text-muted-foreground">{formattedTime(language, worker.last_seen_at ?? worker.created_at)}</p></div><Badge variant={worker.status === "online" ? "secondary" : "outline"}>{worker.status === "online" ? t("online") : t("offline")}</Badge><Button size="icon-sm" variant="ghost" aria-label={t("remove")} disabled={remove.isPending} onClick={() => remove.mutate(worker.id)}><Trash2Icon /></Button></div>)}</CardContent></Card></Page>
}

function ToolsPage() {
  const { t } = useUi()
  const tools = [{ label: t("toolBash"), detail: "bash" }, { label: t("toolBrowser"), detail: "browser_control" }, { label: t("toolComputer"), detail: "computer_use" }]
  return <Page title={t("tools")} description={t("toolsDescription")}><Card><CardContent className="divide-y p-0">{tools.map((tool) => <div className="flex items-center gap-3 px-4 py-4" key={tool.detail}><WrenchIcon className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{tool.label}</p><code className="text-xs text-muted-foreground">{tool.detail}</code></div><Badge variant="outline">Worker</Badge></div>)}</CardContent></Card></Page>
}

function workerToml(pairing: WorkerPairing) {
  return `controller_url = "${pairing.controller_url}"\ntenant_id = "${pairing.tenant_id}"\nmachine_id = "${pairing.machine_id}"\naccess_token = "${pairing.access_token}"\n`
}

function SecretValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="flex items-start gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-foreground">{value}</code><Button size="icon-sm" variant="outline" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button></div>
}

function CreateThreadDialog({ language, open, pending, error, onClose, onCreate }: { language: Language; open: boolean; pending: boolean; error: unknown; onClose: () => void; onCreate: (title: string) => void }) {
  const t = copy[language]
  const [title, setTitle] = useState("")
  useEffect(() => { if (!open) setTitle("") }, [open])
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}><DialogContent><form onSubmit={(event) => { event.preventDefault(); onCreate(title.trim() || "Untitled thread") }}><DialogHeader><DialogTitle>{t.newThread}</DialogTitle><DialogDescription>{t.emptyDescription}</DialogDescription></DialogHeader><FieldGroup className="py-2"><Field><FieldLabel htmlFor="thread-title">{t.threadName}</FieldLabel><Input id="thread-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t.threadName} /></Field></FieldGroup>{Boolean(error) && <RequestError error={error} onRetry={() => onCreate(title.trim() || "Untitled thread")} />}<DialogFooter><Button type="button" variant="outline" onClick={onClose}>{t.cancel}</Button><Button disabled={pending}>{pending ? <Spinner /> : <PlusIcon data-icon="inline-start" />}{t.create}</Button></DialogFooter></form></DialogContent></Dialog>
}

function RequestError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useUi()
  return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t("loadError")}</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span className="break-words">{errorMessage(error)}</span>{onRetry && <Button size="sm" variant="outline" onClick={onRetry}>{t("retry")}</Button>}</AlertDescription></Alert>
}

function Page({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6"><div><h1 className="font-heading text-2xl font-semibold text-balance">{title}</h1>{description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground text-pretty">{description}</p>}</div>{children}</main>
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={({ error, reset }) => <ErrorBoundaryFallback
      error={error}
      reset={reset}
      title="Cybion could not load"
      description="Reload the app to restore your workspace."
      detailsLabel="Error details"
      retryLabel="Try again"
      reloadLabel="Reload"
    />}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <App />
        </HashRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
)
