import { memo, StrictMode, createContext, useContext, useEffect, useMemo, useState } from "react"
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
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  Minimize2Icon,
  PlayIcon,
  SquareIcon,
  DatabaseIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileKey2Icon,
  LanguagesIcon,
  MoonIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SendIcon,
  Settings2Icon,
  SunIcon,
  SparklesIcon,
  TerminalSquareIcon,
  Trash2Icon,
  WrenchIcon,
  UsersIcon,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { generatedImageSource, pendingResponseRecords, threadControlAction, type ThreadResponseView } from "@/lib/thread-response"
import { bashFunctionCall, historyPayloadObject, historyPayloadText } from "@/lib/history-payload"
import { formattedTime } from "@/lib/time"
import { pollThreadHistory, type HistoryRecord } from "@/lib/thread-history"
import { handleChatInputKeyDown } from "@/lib/chat-input"
import { useComposerDraft } from "@/hooks/use-composer-draft"
import { useIsDesktopLayout } from "@/hooks/use-mobile"
import { ComposerDraftNotice } from "@/components/composer-draft-notice"
import { auditCacheRate, openaiAuditUrl } from "@/lib/reasoning-audit"

import "./styles.css"
import "linkit-react-components/styles.css"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorBoundary, ErrorBoundaryFallback } from "@/components/error-boundary"
import { WorkerConnections } from "@/components/worker-connections"
import { AdminUsers } from "@/components/admin-users"
import { LinkitNotifications } from "@/components/linkit-notifications"
import { SystemConfiguration } from "@/components/system-configuration"
import { HistoryTable } from "@/components/history-table"
import { BashCommand } from "@/components/bash-command"
import { ThreadHistory } from "@/components/thread-history"
import { ThreadList } from "@/components/thread-list"
import { ThreadLink, ThreadStatusBadge } from "@/components/thread-status"
import { ThreadUsagePanel } from "@/components/thread-usage"
import type { ThreadUsage } from "@/lib/thread-usage"
import type { ThreadDisplayStatus } from "@/lib/thread-status"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
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
  SelectGroup,
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
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { TooltipProvider } from "@/components/ui/tooltip"

type Language = "en" | "zh"
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const
type ThreadDefaults = {
  model: string
  reasoning_effort: typeof REASONING_EFFORTS[number]
  service_tier_fast: boolean
  web_search: boolean
  image_generation: boolean
}
type ThreadStatus = "idle" | "running" | "failed"
type Thread = ThreadDefaults & {
  id: string
  title: string
  status: ThreadStatus
  display_status: ThreadDisplayStatus
  usage: ThreadUsage
  created_at: number
  updated_at: number
}
type RequestAck = {
  thread_id: string
  record_idx: number
  status: "accepted"
}
type StartThreadInput = ThreadDefaults & { input: string }
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
type ReasoningAudit = {
  id: number
  input_record_id: number | null
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
  idx_head: number | null
  idx_tail: number | null
  error: string | null
}
type ReasoningAuditPage = {
  items: ReasoningAudit[]
  total: number
  page: number
  page_size: number
}
type InsightModel = {
  model: string
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
}
type InsightWorkerItem = {
  worker_id: string
  worker_label: string
  calls: number
  read_bytes: number
  write_bytes: number
}
type Insights = {
  range: "24h" | "7d" | "30d" | "all"
  generated_at: number
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
  worker: { calls: number; read_bytes: number; write_bytes: number; by_worker: InsightWorkerItem[] }
  history: { total_records: number; payload_bytes: number; checkpoint_count: number; latest_record_at: number | null; kinds: { key: string; count: number }[] }
  dimensions: { thread_ids: string[]; models: string[]; request_kinds: string[] }
}
type IntegrationStatus = {
  base_url: string
  api_key_configured: boolean
}
type OpenAiModels = {
  models: string[]
}
type SystemResources = {
  generated_at: number
  sample_interval_ms: number
  process_id: number
  process_version: string
  cpu: {
    usage_percent: number
    load_1m: number
    logical_cpus: number
  }
  memory: {
    used_bytes: number
    total_bytes: number
    available_bytes: number
    process_used_bytes: number
    usage_percent: number
    swap_used_bytes: number
    swap_total_bytes: number
  }
  network: {
    receive_bytes_per_second: number
    transmit_bytes_per_second: number
    total_received_bytes: number
    total_transmitted_bytes: number
    interfaces: number
  }
  disk: {
    mount_point: string
    used_bytes: number
    total_bytes: number
    available_bytes: number
    usage_percent: number
  } | null
  sqlite: {
    main_bytes: number
    wal_bytes: number
    shm_bytes: number
    total_bytes: number
    freelist_bytes: number
    freelist_percent: number
  }
}
type CurrentUser = { user_id: string; hosted: boolean; is_admin: boolean }
type Context = {
  id: string
  name: string
  description: string
  content: string
  parent_id: string | null
}
type WorkerCallAudit = {
  id: string
  worker_id: string
  worker_label: string | null
  worker_hostname: string | null
  worker_version: string | null
  worker_resource: Record<string, unknown> | null
  thread_id: string
  thread_title: string
  input_record_id: number | null
  name: string
  arguments: Record<string, unknown>
  status: "queued" | "delivered" | "completed" | "failed"
  result: unknown
  error: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
}
type WorkerCallAuditPage = {
  items: WorkerCallAudit[]
  total: number
  page: number
  page_size: number
}


const copy = {
  en: {
    threads: "Threads",
    newThread: "New thread",
    newThreadDescription: "Set the working context, then send the first instruction. Cybion will name the thread for you.",
    newThreadPrompt: "What should Cybion work on?",
    startThread: "Start thread",
    startThreadHint: "Your first message creates the thread and starts the model request.",
    threadName: "Thread name",
    create: "Create",
    cancel: "Cancel",
    emptyTitle: "No threads yet",
    emptyDescription: "Start a focused thread. Every thread has its own history and request state.",
    chat: "Thread",
    backToThreads: "Back to thread list",
    send: "Send",
    sendShortcut: "Enter to send · Shift + Enter for a new line",
    startThreadShortcut: "Enter to start · Shift + Enter for a new line",
    stopThread: "Stop",
    stopThreadHint: "Stop reasoning and keep saved records",
    continueThread: "Continue reasoning",
    continueThreadHint: "Continue from saved history without sending a new prompt",
    compactThread: "Compact",
    compactThreadHint: "Compress context into a checkpoint and keep the original records",
    threadStopped: "Reasoning stopped. Saved records were kept.",
    threadContinued: "Continued without a new prompt.",
    threadCompactionRequested: "Checkpoint compaction requested.",
    input: "Give this thread its next instruction…",
    queued: "Queued",
    rename: "Rename",
    generateTitle: "Generate a title from the full conversation",
    delete: "Delete",
    deleteTitle: "Delete this thread?",
    deleteDescription: "Its history and Worker calls will be removed.",
    api: "API keys",
    apiTitle: "Integration API",
    apiDescription: "Create a user-scoped key for another application to create threads and append inputs.",
    apiKeyLabel: "Key label",
    createKey: "Create API key",
    copyNow: "Copy this key now",
    keyWarning: "This secret is shown only once.",
    revoke: "Revoke",
    noKeys: "No API keys yet.",
    workers: "Workers",
    workersTitle: "Cybion Worker",
    workersDescription: "Pair a personal device so a thread can run approved local tools.",
    workerDownloads: "Download Cybion Worker",
    workerDownloadsDescription: "Install the latest Worker release for your platform, then create a pairing below.",
    workerReleaseNotes: "View release notes",
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
    recordToolOutput: "Worker result",
    recordReasoning: "Reasoning",
    recordActivity: "Activity",
    recordCheckpoint: "Checkpoint",
    recordProtocol: "Protocol event",
    generatedImage: "Generated image",
    recordHidden: "Internal",
    recordPayload: "View raw payload",
    navWork: "Work",
    contexts: "Contexts",
    contextsTitle: "Contexts",
    contextsDescription: "Organize reusable context as a tree. Content is loaded only when you open a context.",
    contextEmpty: "No contexts yet.",
    contextName: "Context name",
    contextDescription: "Description",
    contextContent: "Content",
    contextParent: "Parent context",
    contextRoot: "Top-level context",
    newContext: "New context",
    editContext: "Edit context",
    createContext: "Create context",
    saveContext: "Save context",
    deleteContext: "Delete context",
    deleteContextTitle: "Delete this context?",
    deleteContextDescription: "Child contexts will become top-level contexts.",
    contextSaved: "Context saved",
    contextCreated: "Context created",
    contextUpdated: "Context updated",
    contextDeleted: "Context deleted",
    contextCollapse: "Collapse context",
    contextExpand: "Expand context",
    navAudit: "Audit",
    inferenceStats: "Inference statistics",
    navAdministration: "Administration",
    users: "Users",
    usersDescription: "All Cybion users, inference usage, stored records and traffic. Updates every 5 seconds.",
    systemResources: "System resources",
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
    auditLink: "OpenAI Request ID",
    auditOpenLink: "Open audit in OpenAI-LB (new tab)",
    auditCacheRateDescription: "Cached input tokens ÷ input tokens. — when usage is unavailable or input is zero.",
    auditEmpty: "No reasoning requests yet.",
    workerAudit: "Worker call audit",
    workerAuditDescription: "Every Worker call, including queued and in-flight calls.",
    workerAuditEmpty: "No Worker calls yet.",
    workerCall: "Call",
    workerArguments: "Arguments",
    workerResult: "Result",
    workerQueued: "Queued",
    workerDelivered: "Delivered",
    workerCompleted: "Completed",
    workerFailed: "Failed",
    editWorker: "Edit name",
    saveWorker: "Save name",
    workerAuditRange: "{from}–{to} of {total} calls",
    auditRange: "{from}–{to} of {total} requests",
    inferenceStatsDescription: "Token usage, cache efficiency, input/output ratio, calls by model, and Worker byte consumption.",
    statsRange: "Time range",
    stats24h: "Last 24 hours",
    stats7d: "Last 7 days",
    stats30d: "Last 30 days",
    statsAll: "All time",
    statsModel: "Model",
    statsAllModels: "All models",
    statsRequestKind: "Request type",
    statsAllRequestKinds: "All request types",
    statsClearFilters: "Clear filters",
    statsGenerated: "Aggregated {time}",
    statsTokenUsage: "Token usage",
    statsCompletedRequests: "Completed requests",
    statsInputTokens: "Input tokens",
    statsOutputTokens: "Output tokens",
    statsTotalTokens: "Total tokens",
    statsCachedTokens: "Cached input",
    statsCacheRate: "Cache rate",
    statsInputOutputRatio: "Input / output",
    statsRequests: "Request outcomes",
    statsCalls: "Calls",
    statsCompleted: "Completed",
    statsInFlight: "In flight",
    statsFailed: "Failed",
    statsCancelled: "Cancelled",
    statsByModel: "By model",
    statsWorkerBytes: "Worker bytes",
    statsWorkerBytesDescription: "Bytes in Worker call payloads: arguments read by the Worker and results written back.",
    statsWorkerCalls: "Worker calls",
    statsReadBytes: "Read Bytes",
    statsWriteBytes: "Write Bytes",
    statsWorker: "Worker",
    statsNoWorkers: "No Worker calls in this range.",
    statsHistory: "Protocol history",
    statsHistoryRecords: "Records",
    statsPayloadBytes: "Payload bytes",
    statsCheckpoints: "Checkpoints",
    statsLatestRecord: "Latest record",
    statsNoData: "No statistics for this range.",
    previous: "Previous",
    next: "Next",
    pageSize: "Per page",
    systemTitle: "System",
    systemDescription: "Live host resources for Cybion administrators.",
    process: "Process",
    cpu: "CPU",
    cpuLoad: "1-minute load",
    logicalCpus: "Logical CPUs",
    memory: "Memory",
    memoryAvailable: "Available",
    processMemory: "Cybion process",
    swap: "Swap",
    disk: "Disk",
    diskAvailable: "Available",
    sqlite: "SQLite",
    sqliteMain: "Database",
    sqliteWal: "Write-ahead log",
    sqliteShm: "Shared memory",
    sqliteFreelist: "Free pages",
    network: "Network",
    networkNow: "Instantaneous",
    networkReceive: "Receive",
    networkTransmit: "Transmit",
    networkTotal: "Cumulative",
    networkInterfaces: "Interfaces",
    database: "Administrator database",
    activeRequests: "Active requests",
    workerCount: "Workers",
    userId: "User ID",
    sampled: "Sampled",
    sampleInterval: "Sample interval",
    unavailable: "Unavailable",
    configuration: "Personal settings",
    configurationDescription: "Your new-thread defaults, integrations, and workspace access.",
    systemConfiguration: "System configuration",
    systemConfigurationDescription: "Administrator-only global settings for all users' upstream requests.",
    threadDefaults: "New thread defaults",
    threadDefaultsDescription: "Applied when you create a thread. You can adjust these settings within each thread.",
    reasoningEffort: "Reasoning effort",
    fastMode: "Fast mode",
    fastModeDescription: "Use priority processing for new threads.",
    webSearchDescription: "Inject the web search tool into new thread requests.",
    imageGenerationDescription: "Inject the image generation tool into new thread requests.",
    saveDefaults: "Save defaults",
    savingDefaults: "Saving…",
    defaultsSaved: "Defaults saved",
    saveDefaultsError: "Could not save thread defaults",
    integrationDescription: "Configure the Responses-compatible API used for model inference. Notification settings are independent.",
    integration: "Integrations",
    openai: "Responses-compatible API",
    apiBaseUrl: "Base URL",
    apiBaseUrlDescription: "Cybion sends model requests to this URL with /responses appended.",
    apiKey: "API key",
    apiKeyDescription: "Stored per user and never returned to the browser.",
    apiKeyConfigured: "API key configured",
    saveApiConfig: "Save API configuration",
    savingApiConfig: "Saving…",
    apiConfigSaved: "API configuration saved",
    apiConfigSaveError: "Could not save API configuration",
    apiConfigLoadError: "Could not load API configuration",
    apiKeyPlaceholder: "Enter a new API key to replace the current key",
    availableModels: "Available models",
    availableModelsDescription: "Model identifiers reported by GET /models on the configured base URL.",
    refreshModels: "Refresh models",
    noModels: "The endpoint reported no models.",
    linkit: "Linkit",
    configured: "Configured",
    notConfigured: "Not configured",
    baseUrl: "Base URL",
    username: "Username",
    tools: "Tools",
    toolsDescription: "Capabilities available to Cybion threads.",
    toolBash: "Run shell commands",
    toolBrowser: "Control a browser",
    toolComputer: "Control the desktop",
    toolWebSearch: "Web search",
    toolImageGeneration: "Image generation",
    toolOpenAi: "OpenAI",
    history: "History",
    historyDescription: "Browse the rows and stored fields in history_records across your workspace.",
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
    newThreadDescription: "先设置工作上下文，再发送第一条指令。Cybion 会自动为线程命名。",
    newThreadPrompt: "你希望 Cybion 处理什么？",
    startThread: "开始线程",
    startThreadHint: "发送第一条消息后才会创建线程并开始模型请求。",
    threadName: "线程名称",
    create: "创建",
    cancel: "取消",
    emptyTitle: "还没有线程",
    emptyDescription: "创建一个聚焦的线程。每个线程都拥有独立的历史和请求状态。",
    chat: "线程",
    backToThreads: "返回线程列表",
    send: "发送",
    sendShortcut: "Enter 发送 · Shift + Enter 换行",
    startThreadShortcut: "Enter 开始线程 · Shift + Enter 换行",
    stopThread: "停止",
    stopThreadHint: "停止推理，保留已保存的记录",
    continueThread: "继续推理",
    continueThreadHint: "从已有记录继续，不发送新的提示词",
    compactThread: "压缩",
    compactThreadHint: "将上下文压缩为 checkpoint，保留原始记录",
    threadStopped: "推理已停止，已保存的记录保留。",
    threadContinued: "已直接继续推理，未发送新提示词。",
    threadCompactionRequested: "已请求压缩上下文，生成 checkpoint。",
    input: "为这个线程追加下一条指令…",
    queued: "排队中",
    rename: "重命名",
    generateTitle: "引用全部上下文生成标题",
    delete: "删除",
    deleteTitle: "删除这个线程？",
    deleteDescription: "该线程的历史和 Worker 调用都会被删除。",
    api: "API 密钥",
    apiTitle: "集成 API",
    apiDescription: "创建仅属于当前用户的密钥，让其他应用创建线程或追加输入。",
    apiKeyLabel: "Key 名称",
    createKey: "创建 API Key",
    copyNow: "立即复制此 Key",
    keyWarning: "密钥只会显示一次。",
    revoke: "撤销",
    noKeys: "还没有 API Key。",
    workers: "Worker",
    workersTitle: "Cybion Worker",
    workersDescription: "配对个人设备，让线程可以调用经过授权的本地工具。",
    workerDownloads: "下载 Cybion Worker",
    workerDownloadsDescription: "先下载适合你平台的最新 Worker 版本，再在下方创建配对。",
    workerReleaseNotes: "查看发布说明",
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
    recordToolOutput: "Worker 结果",
    recordReasoning: "推理 (Reasoning)",
    recordActivity: "活动记录",
    recordCheckpoint: "上下文检查点",
    recordProtocol: "协议事件",
    generatedImage: "生成的图片",
    recordHidden: "内部记录",
    recordPayload: "查看原始负载",
    navWork: "工作",
    contexts: "上下文",
    contextsTitle: "上下文",
    contextsDescription: "用树形结构组织可复用上下文。只有打开上下文时才加载内容。",
    contextEmpty: "还没有上下文。",
    contextName: "上下文名称",
    contextDescription: "描述",
    contextContent: "内容",
    contextParent: "父级上下文",
    contextRoot: "顶层上下文",
    newContext: "新建上下文",
    editContext: "编辑上下文",
    createContext: "创建上下文",
    saveContext: "保存上下文",
    deleteContext: "删除上下文",
    deleteContextTitle: "删除这个上下文？",
    deleteContextDescription: "子上下文会变成顶层上下文。",
    contextSaved: "上下文已保存",
    contextCreated: "上下文已创建",
    contextUpdated: "上下文已更新",
    contextDeleted: "上下文已删除",
    contextCollapse: "收起上下文",
    contextExpand: "展开上下文",
    navAudit: "审计",
    inferenceStats: "推理统计",
    navAdministration: "管理员",
    users: "用户",
    usersDescription: "所有 Cybion 用户的推理用量、数据记录与网络流量，每 5 秒刷新。",
    systemResources: "系统资源",
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
    auditLink: "OpenAI Request ID",
    auditOpenLink: "在 OpenAI-LB 中查看审计（新标签页）",
    auditCacheRateDescription: "缓存输入 Token ÷ 输入 Token。用量尚未上报或输入为零时显示 —。",
    auditEmpty: "尚无推理请求。",
    workerAudit: "Worker 调用审计",
    workerAuditDescription: "展示所有 Worker 调用，包括排队和在途调用。",
    workerAuditEmpty: "尚无 Worker 调用。",
    workerCall: "调用",
    workerArguments: "参数",
    workerResult: "结果",
    workerQueued: "排队",
    workerDelivered: "已投递",
    workerCompleted: "已完成",
    workerFailed: "失败",
    editWorker: "编辑名称",
    saveWorker: "保存名称",
    workerAuditRange: "第 {from}–{to} 条，共 {total} 次调用",
    auditRange: "第 {from}–{to} 条，共 {total} 个请求",
    inferenceStatsDescription: "按模型查看 Token 用量、缓存效率、输入输出比、调用次数，以及 Worker 字节消耗。",
    statsRange: "时间范围",
    stats24h: "近 24 小时",
    stats7d: "近 7 天",
    stats30d: "近 30 天",
    statsAll: "全部时间",
    statsModel: "模型",
    statsAllModels: "全部模型",
    statsRequestKind: "请求类型",
    statsAllRequestKinds: "全部请求类型",
    statsClearFilters: "清除筛选",
    statsGenerated: "聚合时间 {time}",
    statsTokenUsage: "Token 用量",
    statsCompletedRequests: "已完成请求",
    statsInputTokens: "输入 Token",
    statsOutputTokens: "输出 Token",
    statsTotalTokens: "总 Token",
    statsCachedTokens: "缓存输入",
    statsCacheRate: "缓存率",
    statsInputOutputRatio: "输入 / 输出",
    statsRequests: "请求结果",
    statsCalls: "调用次数",
    statsCompleted: "已完成",
    statsInFlight: "在途",
    statsFailed: "失败",
    statsCancelled: "已取消",
    statsByModel: "按模型",
    statsWorkerBytes: "Worker 字节",
    statsWorkerBytesDescription: "Worker 调用负载的字节数：Worker 读取的参数与写回的结果。",
    statsWorkerCalls: "Worker 调用",
    statsReadBytes: "读取 Bytes",
    statsWriteBytes: "写入 Bytes",
    statsWorker: "Worker",
    statsNoWorkers: "当前范围没有 Worker 调用。",
    statsHistory: "协议历史",
    statsHistoryRecords: "记录数",
    statsPayloadBytes: "负载字节",
    statsCheckpoints: "检查点",
    statsLatestRecord: "最近记录",
    statsNoData: "当前范围没有统计数据。",
    previous: "上一页",
    next: "下一页",
    pageSize: "每页",
    systemTitle: "系统资源",
    systemDescription: "管理员查看 Cybion 主机的实时资源使用情况。",
    process: "进程",
    cpu: "CPU",
    cpuLoad: "1 分钟负载",
    logicalCpus: "逻辑 CPU",
    memory: "内存",
    memoryAvailable: "可用",
    processMemory: "Cybion 进程",
    swap: "交换空间",
    disk: "磁盘",
    diskAvailable: "可用",
    sqlite: "SQLite",
    sqliteMain: "数据库",
    sqliteWal: "预写日志",
    sqliteShm: "共享内存",
    sqliteFreelist: "空闲页",
    network: "网络",
    networkNow: "即时流量",
    networkReceive: "接收",
    networkTransmit: "发送",
    networkTotal: "累计流量",
    networkInterfaces: "网络接口",
    database: "管理员数据库",
    activeRequests: "活动请求",
    workerCount: "Worker 数量",
    userId: "用户 ID",
    sampled: "采样时间",
    sampleInterval: "采样间隔",
    unavailable: "不可用",
    configuration: "个人配置",
    configurationDescription: "当前账号的线程默认设置、外部集成和工作区访问入口。",
    systemConfiguration: "系统配置",
    systemConfigurationDescription: "仅管理员可修改，影响所有用户的上游请求。",
    threadDefaults: "新线程默认设置",
    threadDefaultsDescription: "创建新线程时自动应用，也可以在每个线程中单独调整。",
    reasoningEffort: "推理强度",
    fastMode: "Fast 模式",
    fastModeDescription: "新线程默认使用优先处理。",
    webSearchDescription: "新线程的模型请求默认注入网页搜索工具。",
    imageGenerationDescription: "新线程的模型请求默认注入图像生成工具。",
    saveDefaults: "保存默认设置",
    savingDefaults: "保存中…",
    defaultsSaved: "默认设置已保存",
    saveDefaultsError: "无法保存线程默认设置",
    integrationDescription: "配置用于模型推理的 Responses-compatible API。通知配置与此独立。",
    integration: "集成",
    openai: "Responses-compatible API",
    apiBaseUrl: "基础地址",
    apiBaseUrlDescription: "Cybion 会在这个地址后追加 /responses 发送模型请求。",
    apiKey: "API Key",
    apiKeyDescription: "按用户保存，永远不会返回到浏览器。",
    apiKeyConfigured: "API Key 已配置",
    saveApiConfig: "保存 API 配置",
    savingApiConfig: "保存中…",
    apiConfigSaved: "API 配置已保存",
    apiConfigSaveError: "无法保存 API 配置",
    apiConfigLoadError: "无法加载 API 配置",
    apiKeyPlaceholder: "输入新的 API Key 以替换当前值",
    availableModels: "可用模型",
    availableModelsDescription: "由已配置基础地址的 GET /models 返回的模型标识。",
    refreshModels: "刷新模型",
    noModels: "端点没有返回任何模型。",
    linkit: "Linkit",
    configured: "已配置",
    notConfigured: "未配置",
    baseUrl: "基础地址",
    username: "用户名",
    tools: "工具",
    toolsDescription: "Cybion 线程可使用的能力。",
    toolBash: "运行 Shell 命令",
    toolBrowser: "控制浏览器",
    toolComputer: "控制桌面",
    toolWebSearch: "网页搜索",
    toolImageGeneration: "图像生成",
    toolOpenAi: "OpenAI",
    history: "历史",
    historyDescription: "查看当前工作区 history_records 表中的记录与原始字段。",
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
  // Preserve only a validated, non-secret pairing code across hosted sign-in.
  const route = new URLSearchParams(location.hash.split("?")[1] ?? "")
  const code = route.get("code")
  const target = location.hash.startsWith("#/workers") && code && /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)
    ? `#/workers?code=${code}` : "#/auth/callback"
  return `${location.origin}${location.pathname}${target}`
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

function useOpenAiModels(sdk: AuthMiniApi) {
  return useQuery({
    queryKey: ["openai-models"],
    queryFn: ({ signal }) => api<OpenAiModels>(sdk, "/api/integrations/openai/models", { signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

// The configured endpoint owns the model catalog, but a thread saved earlier
// must stay selectable even after its model leaves the catalog.
function modelOptions(models: string[], current: string) {
  return models.includes(current) ? models : [current, ...models]
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
  const labels = copy[language]
  const currentUser = useQuery({
    queryKey: ["me", sdk.session.getState().sessionId],
    queryFn: ({ signal }) => api<CurrentUser>(sdk, "/api/me", { signal }),
    staleTime: 60_000,
  })
  const threads = useQuery({
    queryKey: ["threads", sdk.session.getState().sessionId],
    queryFn: () => api<Thread[]>(sdk, "/api/threads"),
    refetchInterval: 2000,
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
        {currentUser.isPending ? <LoadingScreen /> : currentUser.error ? <Page title="Cybion" description=""><RequestError error={currentUser.error} onRetry={() => void currentUser.refetch()} /></Page> : <WorkspaceShell
          key={currentUser.data.user_id}
          sdk={sdk}
          userId={currentUser.data.user_id}
          isAdmin={currentUser.data.is_admin}
          threads={threads.data ?? []}
          threadsLoading={threads.isLoading}
          threadsError={threads.error}
        />}
      </ErrorBoundary>
    </UiContext.Provider>
  </LinkitProvider>
}

function WorkspaceShell({
  sdk,
  userId,
  isAdmin,
  threads,
  threadsLoading,
  threadsError,
}: {
  sdk: AuthMiniApi
  userId: string
  isAdmin: boolean
  threads: Thread[]
  threadsLoading: boolean
  threadsError: unknown
}) {
  const { language, dark, toggleTheme, setLanguage, t } = useUi()
  const location = useLocation()
  const navigate = useNavigate()
  const routeTitle = pageTitle(location.pathname, t)
  const workNav = [
    { to: "/threads", label: t("threads"), icon: TerminalSquareIcon },
    { to: "/contexts", label: t("contexts"), icon: NetworkIcon },
    { to: "/workers", label: t("workers"), icon: NetworkIcon },
  ]
  const auditNav = [
    { to: "/insights", label: t("inferenceStats"), icon: ActivityIcon },
    { to: "/reasoning-audit", label: t("audit"), icon: ActivityIcon },
    { to: "/worker-audit", label: t("workerAudit"), icon: WrenchIcon },
    { to: "/history", label: t("history"), icon: DatabaseIcon },
  ]
  const administrationNav = isAdmin
    ? [
      { to: "/admin/users", label: t("users"), icon: UsersIcon },
      { to: "/system", label: t("systemResources"), icon: ActivityIcon },
      { to: "/admin/configuration", label: t("systemConfiguration"), icon: Settings2Icon },
    ]
    : []
  const configurationNav = [
    { to: "/configuration", label: t("configuration"), icon: Settings2Icon },
    { to: "/api", label: t("api"), icon: FileKey2Icon },
    { to: "/tools", label: t("tools"), icon: WrenchIcon },
  ]
  const nav: WorkspaceNavGroup[] = [
    { id: "work", label: t("navWork"), items: workNav },
    { id: "audit", label: t("navAudit"), items: auditNav },
    ...(administrationNav.length > 0 ? [{ id: "administration", label: t("navAdministration"), items: administrationNav }] : []),
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
            <Route path="/threads" element={<ThreadsHomePage sdk={sdk} userId={userId} threads={threads} threadsLoading={threadsLoading} threadsError={threadsError} />} />
            <Route path="/threads/new" element={<NewThreadPage sdk={sdk} userId={userId} threads={threads} threadsLoading={threadsLoading} threadsError={threadsError} />} />
            <Route path="/threads/:threadId" element={<ThreadConversation key={location.pathname} sdk={sdk} userId={userId} threads={threads} onCreate={() => navigate("/threads")} />} />
            <Route path="/contexts" element={<ContextsPage sdk={sdk} />} />
            <Route path="/insights" element={<InsightsPage sdk={sdk} />} />
            <Route path="/reasoning-audit" element={<ReasoningAuditPage sdk={sdk} />} />
            <Route path="/worker-audit" element={<WorkerAuditPage sdk={sdk} />} />
            <Route path="/history" element={<HistoryPage sdk={sdk} />} />
            <Route path="/admin/users" element={<Page title={t("users")} description={t("usersDescription")}><AdminUsers language={language} allowed={isAdmin} sessionId={sdk.session.getState().sessionId} request={(signal) => api(sdk, "/api/admin/users", { signal })} /></Page>} />
            <Route path="/admin/resources" element={<SystemPage sdk={sdk} />} />
            <Route path="/system" element={<SystemPage sdk={sdk} />} />
            <Route path="/resources" element={<SystemPage sdk={sdk} />} />
            <Route path="/workers" element={<WorkersPage sdk={sdk} />} />
            <Route path="/admin/configuration" element={<SystemConfigurationPage sdk={sdk} />} />
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
  if (pathname.startsWith("/contexts")) return t("contextsTitle")
  if (pathname.startsWith("/insights")) return t("inferenceStats")
  if (pathname.startsWith("/reasoning-audit")) return t("audit")
  if (pathname.startsWith("/worker-audit")) return t("workerAudit")
  if (pathname.startsWith("/history")) return t("history")
  if (pathname.startsWith("/admin/users")) return t("users")
  if (pathname.startsWith("/admin/configuration")) return t("systemConfiguration")
  if (pathname.startsWith("/admin/resources") || pathname.startsWith("/system") || pathname.startsWith("/resources")) return t("systemTitle")
  if (pathname.startsWith("/workers")) return t("workers")
  if (pathname.startsWith("/configuration") || pathname.startsWith("/settings")) return t("configuration")
  if (pathname.startsWith("/api")) return t("api")
  if (pathname.startsWith("/tools")) return t("tools")
  return t("threads")
}

function ThreadsHomePage({ sdk, userId, threads, threadsLoading, threadsError }: { sdk: AuthMiniApi; userId: string; threads: Thread[]; threadsLoading: boolean; threadsError: unknown }) {
  const desktop = useIsDesktopLayout()
  if (desktop) return <NewThreadPage sdk={sdk} userId={userId} threads={threads} threadsLoading={threadsLoading} threadsError={threadsError} />
  return <ThreadListPage threads={threads} threadsLoading={threadsLoading} />
}

function ThreadListPage({ threads, threadsLoading }: { threads: Thread[]; threadsLoading: boolean }) {
  const { language } = useUi()
  const navigate = useNavigate()
  return <main className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col">
    <ThreadList threads={threads} loading={threadsLoading} language={language} onCreate={() => navigate("/threads/new")} />
  </main>
}

function NewThreadPage({ sdk, userId, threads, threadsLoading, threadsError }: { sdk: AuthMiniApi; userId: string; threads: Thread[]; threadsLoading: boolean; threadsError: unknown }) {
  const { t, language } = useUi()
  const navigate = useNavigate()
  const desktop = useIsDesktopLayout()
  const client = useQueryClient()
  const defaults = useQuery({ queryKey: ["thread-defaults"], queryFn: ({ signal }) => api<ThreadDefaults>(sdk, "/api/thread-defaults", { signal }) })
  const models = useOpenAiModels(sdk)
  const [draft, setDraft] = useState<ThreadDefaults | null>(null)
  const location = useLocation()
  const composer = useComposerDraft(userId, null)
  const { input, setInput, seed, clearSubmitted } = composer
  useEffect(() => {
    if (typeof location.state?.initialInput !== "string") return
    const { initialInput, ...state } = location.state
    seed(initialInput)
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state })
  }, [location, navigate, seed])
  const value = draft ?? defaults.data
  const start = useMutation({
    mutationFn: (payload: StartThreadInput) => api<RequestAck>(sdk, "/api/threads/start", { method: "POST", body: JSON.stringify({ ...payload, input: payload.input.trim() }) }),
    onSuccess: (_request, payload) => {
      clearSubmitted(payload.input)
      void client.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const edit = (next: ThreadDefaults) => {
    setDraft(next)
    start.reset()
  }
  const submit = () => {
    const message = input.trim()
    if (!value || !message || start.isPending) return
    start.mutate({ ...value, input }, { onSuccess: (request) => navigate(`/threads/${request.thread_id}`) })
  }
  return <main className="flex min-h-[calc(100svh-3.5rem)] flex-col lg:flex-row">
    {desktop && <aside className="border-b bg-sidebar/40 p-3 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <p className="text-xs font-medium text-muted-foreground">{t("threads")}</p>
        <Button size="icon-sm" variant="ghost" aria-label={t("newThread")} onClick={() => navigate("/threads")}><PlusIcon /></Button>
      </div>
      <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-9rem)]" aria-label={t("threads")}>
        {threadsLoading && <div className="flex flex-col gap-2 px-2 py-1"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>}
        {!threadsLoading && threads.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">{t("emptyTitle")}</p>}
        {!threadsLoading && threads.map((thread) => <ThreadLink key={thread.id} thread={thread} language={language} />)}
        {Boolean(threadsError) && <p className="px-3 py-2 text-xs text-destructive">{errorMessage(threadsError)}</p>}
      </nav>
    </aside>}
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-4 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="text-lg font-semibold tracking-tight">{t("newThread")}</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t("newThreadDescription")}</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {defaults.error && <RequestError error={defaults.error} onRetry={() => void defaults.refetch()} />}
          {defaults.isLoading && <div className="flex flex-col gap-3"><Skeleton className="h-24" /><Skeleton className="h-20" /></div>}
          {value && <section className="rounded-xl border bg-card p-4 sm:p-5" aria-labelledby="new-thread-settings">
            <div className="mb-5"><h2 id="new-thread-settings" className="text-sm font-semibold">{t("threadDefaults")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("threadDefaultsDescription")}</p></div>
            <div className="grid gap-5 md:grid-cols-2">
              <Field data-disabled={start.isPending}>
                <FieldLabel htmlFor="new-thread-model">{t("model")}</FieldLabel>
                <Select value={value.model} disabled={start.isPending} onValueChange={(model) => edit({ ...value, model })}>
                  <SelectTrigger id="new-thread-model"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{modelOptions(models.data?.models ?? [], value.model).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
                {models.isError && <FieldDescription>{errorMessage(models.error)}</FieldDescription>}
              </Field>
              <Field data-disabled={start.isPending}>
                <FieldLabel htmlFor="new-thread-reasoning">{t("reasoningEffort")}</FieldLabel>
                <Select value={value.reasoning_effort} disabled={start.isPending} onValueChange={(reasoning_effort) => edit({ ...value, reasoning_effort: reasoning_effort as ThreadDefaults["reasoning_effort"] })}>
                  <SelectTrigger id="new-thread-reasoning"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{REASONING_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field orientation="horizontal" className="md:col-span-2" data-disabled={start.isPending}>
                <FieldContent><FieldLabel htmlFor="new-thread-fast">{t("fastMode")}</FieldLabel><FieldDescription id="new-thread-fast-description">{t("fastModeDescription")}</FieldDescription></FieldContent>
                <Switch id="new-thread-fast" aria-describedby="new-thread-fast-description" checked={value.service_tier_fast} disabled={start.isPending} onCheckedChange={(service_tier_fast) => edit({ ...value, service_tier_fast })} />
              </Field>
              <Field orientation="horizontal" data-disabled={start.isPending}>
                <FieldContent><FieldLabel htmlFor="new-thread-web-search">{t("toolWebSearch")}</FieldLabel><FieldDescription id="new-thread-web-search-description">{t("webSearchDescription")}</FieldDescription></FieldContent>
                <Switch id="new-thread-web-search" aria-describedby="new-thread-web-search-description" checked={value.web_search} disabled={start.isPending} onCheckedChange={(web_search) => edit({ ...value, web_search })} />
              </Field>
              <Field orientation="horizontal" data-disabled={start.isPending}>
                <FieldContent><FieldLabel htmlFor="new-thread-image-generation">{t("toolImageGeneration")}</FieldLabel><FieldDescription id="new-thread-image-generation-description">{t("imageGenerationDescription")}</FieldDescription></FieldContent>
                <Switch id="new-thread-image-generation" aria-describedby="new-thread-image-generation-description" checked={value.image_generation} disabled={start.isPending} onCheckedChange={(image_generation) => edit({ ...value, image_generation })} />
              </Field>
            </div>
          </section>}
          <div className="rounded-xl border border-dashed bg-muted/20 p-5 sm:p-6">
            <div className="flex items-start gap-3"><div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><SparklesIcon className="size-4" /></div><div><h2 className="text-sm font-semibold">{t("startThread")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("startThreadHint")}</p></div></div>
          </div>
          {start.error && <RequestError error={start.error} onRetry={submit} />}
        </div>
      </div>
      <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <div className="mx-auto w-full max-w-3xl"><FieldGroup><Field><FieldLabel className="sr-only" htmlFor="new-thread-input">{t("newThreadPrompt")}</FieldLabel><Textarea id="new-thread-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("newThreadPrompt")} onKeyDown={handleChatInputKeyDown} aria-describedby="new-thread-input-shortcut" disabled={!value || start.isPending} /><ComposerDraftNotice language={language} storageError={composer.storageError} /></Field><div className="flex items-center justify-between gap-3"><span id="new-thread-input-shortcut" className="text-xs text-muted-foreground">{t("startThreadShortcut")}</span><Button disabled={!value || !input.trim() || start.isPending}>{start.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t("startThread")}</Button></div></FieldGroup></div>
      </form>
    </section>
  </main>
}

function ThreadConversation({ sdk, userId, threads, onCreate }: { sdk: AuthMiniApi; userId: string; threads: Thread[]; onCreate: () => void }) {
  const { threadId = "" } = useParams()
  const { t, language } = useUi()
  const navigate = useNavigate()
  const desktop = useIsDesktopLayout()
  const client = useQueryClient()
  const thread = useQuery({
    queryKey: ["thread", threadId, userId],
    queryFn: () => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`),
    refetchInterval: 1500,
    enabled: Boolean(threadId),
  })
  const workers = useQuery({
    queryKey: ["workers", userId],
    queryFn: () => api<Worker[]>(sdk, "/api/workers"),
    refetchInterval: 5000,
  })
  const models = useOpenAiModels(sdk)
  const history = useQuery({
    queryKey: ["history", threadId, userId],
    queryFn: () => pollThreadHistory(
      client.getQueryData<HistoryRecord[]>(["history", threadId, userId]),
      (after) => api<HistoryRecord[]>(sdk, `/api/threads/${encodeURIComponent(threadId)}/history?after=${after}`),
    ),
    refetchInterval: thread.data?.status === "running" ? 1200 : 2500,
    enabled: Boolean(threadId),
  })
  const liveResponse = useQuery({
    queryKey: ["thread-response", threadId, thread.data?.status, userId],
    queryFn: () => api<ThreadResponseView | null>(sdk, `/api/threads/${encodeURIComponent(threadId)}/response`),
    refetchInterval: thread.data?.status === "running" ? 750 : false,
    enabled: Boolean(threadId),
  })
  const records = useMemo(() => [
    ...history.data ?? [],
    ...pendingResponseRecords(liveResponse.data, history.data ?? [], threadId),
  ], [history.data, liveResponse.data, threadId])
  const composer = useComposerDraft(userId, threadId)
  const { input, setInput, clearSubmitted } = composer
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    setTitle(thread.data?.title ?? "")
    setEditing(false)
  }, [threadId, thread.data?.title])
  const submit = useMutation({
    mutationFn: (value: string) => api<RequestAck>(sdk, `/api/threads/${encodeURIComponent(threadId)}/inputs`, {
      method: "POST",
      body: JSON.stringify({ input: value.trim() }),
    }),
    onSuccess: (_request, submitted) => {
      clearSubmitted(submitted)
      void client.invalidateQueries({ queryKey: ["history", threadId] })
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["reasoning-audits"] })
    },
  })
  const control = useMutation({
    mutationFn: (action: "cancel" | "continue" | "compact") => api<unknown>(sdk, `/api/threads/${encodeURIComponent(threadId)}/${action}`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["history", threadId] }),
        client.invalidateQueries({ queryKey: ["thread", threadId] }),
        client.invalidateQueries({ queryKey: ["thread-response", threadId] }),
        client.invalidateQueries({ queryKey: ["threads"] }),
        client.invalidateQueries({ queryKey: ["reasoning-audits"] }),
        client.invalidateQueries({ queryKey: ["worker-calls"] }),
      ])
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
  const generateTitle = useMutation({
    mutationFn: () => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}/title`, { method: "POST" }),
    onSuccess: (thread: Thread) => {
      setTitle(thread.title)
      setEditing(false)
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
      void client.invalidateQueries({ queryKey: ["reasoning-audits"] })
    },
  })
  const settings = useMutation({
    mutationFn: (value: { model?: string; reasoning_effort?: Thread["reasoning_effort"]; service_tier_fast?: boolean; web_search?: boolean; image_generation?: boolean }) => api<Thread>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify(value) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["thread", threadId] }); void client.invalidateQueries({ queryKey: ["threads"] }) },
  })
  const remove = useMutation({
    mutationFn: () => api<unknown>(sdk, `/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleteOpen(false)
      composer.clear()
      void client.invalidateQueries({ queryKey: ["threads"] })
      navigate("/threads")
    },
  })
  if (thread.isLoading) return <Page title={t("chat")} description=""><div className="flex flex-col gap-3"><Skeleton className="h-8 w-56" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div></Page>
  if (thread.isError || !thread.data) return <Page title={t("chat")} description=""><RequestError error={thread.error} /></Page>
  const current = thread.data
  const running = current.status === "running"
  const busy = submit.isPending || control.isPending
  const hasHistory = history.data?.some((record) => record.kind !== "activity") ?? false
  return <main className="flex h-full flex-col lg:flex-row">
    {desktop && <aside className="border-b bg-sidebar/40 p-3 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <p className="text-xs font-medium text-muted-foreground">{t("threads")}</p>
        <Button size="icon-sm" variant="ghost" aria-label={t("newThread")} onClick={onCreate}><PlusIcon /></Button>
      </div>
      <nav className="flex max-h-44 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100svh-9rem)]" aria-label={t("threads")}>
        {threads.map((item) => <ThreadLink key={item.id} thread={item.id === current.id ? current : item} language={language} />)}
      </nav>
    </aside>}
    <section className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        {!desktop && <Button variant="ghost" size="icon-sm" aria-label={t("backToThreads")} onClick={() => navigate("/threads")}><ArrowLeftIcon /></Button>}
        {editing ? <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (title.trim()) rename.mutate(title.trim()) }}>
          <Input aria-label={t("threadName")} value={title} onChange={(event) => setTitle(event.target.value)} disabled={generateTitle.isPending} />
          <Button type="button" size="icon-sm" variant="outline" aria-label={t("generateTitle")} title={t("generateTitle")} disabled={generateTitle.isPending || !hasHistory} onClick={() => generateTitle.mutate()}>{generateTitle.isPending ? <Spinner /> : <SparklesIcon className="size-4" />}</Button>
          <Button size="sm" disabled={rename.isPending || generateTitle.isPending}>{rename.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{t("rename")}</Button>
        </form> : <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold">{current.title}</h1><p className="truncate text-xs text-muted-foreground">{current.model}</p></div>}
        <ThreadStatusBadge status={current.display_status} language={language} />
        {!editing && <div className="flex flex-wrap items-center gap-2"><Select value={current.model} onValueChange={(value) => settings.mutate({ model: value })}><SelectTrigger size="sm" aria-label={t("model")}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{modelOptions(models.data?.models ?? [], current.model).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectGroup></SelectContent></Select><Select value={current.reasoning_effort} onValueChange={(value) => settings.mutate({ reasoning_effort: value as Thread["reasoning_effort"] })}><SelectTrigger size="sm" aria-label={t("reasoningEffort")}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{REASONING_EFFORTS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select><Button size="sm" variant={current.service_tier_fast ? "default" : "outline"} onClick={() => settings.mutate({ service_tier_fast: !current.service_tier_fast })}>Fast {current.service_tier_fast ? "on" : "off"}</Button><Button size="sm" variant={current.web_search ? "default" : "outline"} onClick={() => settings.mutate({ web_search: !current.web_search })}>{t("toolWebSearch")} {current.web_search ? "on" : "off"}</Button><Button size="sm" variant={current.image_generation ? "default" : "outline"} onClick={() => settings.mutate({ image_generation: !current.image_generation })}>{t("toolImageGeneration")} {current.image_generation ? "on" : "off"}</Button><Button variant="ghost" size="sm" onClick={() => setEditing(true)}>{t("rename")}</Button></div>}
        <Button variant="ghost" size="icon-sm" aria-label={t("delete")} onClick={() => setDeleteOpen(true)}><Trash2Icon /></Button>
      </div>
      <ThreadUsagePanel usage={current.usage} language={language} />
      {submit.error && <div className="shrink-0 p-3"><RequestError error={submit.error} onRetry={() => input.trim() && submit.mutate(input)} /></div>}
      {control.error && <div className="shrink-0 p-3"><RequestError error={control.error} /></div>}
      {generateTitle.error && <div className="shrink-0 p-3"><RequestError error={generateTitle.error} onRetry={() => generateTitle.mutate()} /></div>}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent spacerClassName="hidden" className="mx-auto w-full max-w-4xl px-4 py-5 sm:px-6">
              {history.isLoading && <div className="flex flex-col gap-3"><Skeleton className="h-18" /><Skeleton className="ml-auto h-18 w-4/5" /></div>}
              {history.error && <RequestError error={history.error} onRetry={() => void history.refetch()} />}
              <ThreadHistory records={records} language={language} renderRecord={(record) => <HistoryMessage language={language} record={record} workers={workers.data} />} />
              {!history.isLoading && !history.error && history.data?.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">{t("noHistory")}</div>}
              {liveResponse.data && <MessageScrollerItem><ResponseMetadata language={language} view={liveResponse.data} running={current.status === "running"} /></MessageScrollerItem>}
              {running && <MessageScrollerItem><div role="status"><ThreadStatusBadge status={current.display_status} language={language} /></div></MessageScrollerItem>}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton behavior="auto" />
        </MessageScroller>
      </MessageScrollerProvider>
      <form className="shrink-0 border-t bg-background p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); const value = input.trim(); if (value && !busy) submit.mutate(input) }}>
        <FieldGroup><Field><FieldLabel className="sr-only" htmlFor="thread-input">{t("input")}</FieldLabel><Textarea id="thread-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t("input")} onKeyDown={handleChatInputKeyDown} aria-describedby="thread-input-shortcut" disabled={busy} /><ComposerDraftNotice language={language} storageError={composer.storageError} /></Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {running
                ? <Button type="button" variant="outline" disabled={busy} title={t("stopThreadHint")} onClick={() => control.mutate("cancel")}>{control.isPending && control.variables === "cancel" ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}{t("stopThread")}</Button>
                : <Button type="button" variant="outline" disabled={busy || !hasHistory} title={t("continueThreadHint")} onClick={() => control.mutate("continue")}>{control.isPending && control.variables === "continue" ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}{t("continueThread")}</Button>}
              <Button type="button" variant="ghost" disabled={running || busy || !hasHistory} title={t("compactThreadHint")} onClick={() => control.mutate("compact")}>{control.isPending && control.variables === "compact" ? <Spinner data-icon="inline-start" /> : <Minimize2Icon data-icon="inline-start" />}{t("compactThread")}</Button>
            </div>
            <div className="flex items-center gap-3"><span id="thread-input-shortcut" className="hidden text-xs text-muted-foreground sm:inline">{t("sendShortcut")}</span><Button disabled={!input.trim() || busy}>{submit.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t("send")}</Button></div>
          </div>
        </FieldGroup>
      </form>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent><DialogHeader><DialogTitle>{t("deleteTitle")}</DialogTitle><DialogDescription>{t("deleteDescription")}</DialogDescription></DialogHeader>{remove.error && <RequestError error={remove.error} onRetry={() => remove.mutate()} />}<DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("cancel")}</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}{t("delete")}</Button></DialogFooter></DialogContent></Dialog>
    </section>
  </main>
}

function ResponseMetadata({ language, view, running }: { language: Language; view: ThreadResponseView; running: boolean }) {
  const response = view.response
  const buffering = running && !response.completed && response.safety_buffering?.show_buffering_ui
  return <div className="flex flex-col gap-2 py-2">
    {buffering && <Alert><Spinner /><AlertTitle>{language === "zh" ? "正在等待安全检查" : "Waiting for safety checks"}</AlertTitle><AlertDescription>{response.safety_buffering?.reasons.join(" · ")}</AlertDescription></Alert>}
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{response.server_model ?? (language === "zh" ? "响应信息" : "Response details")}{response.usage ? ` · ${response.usage.input_tokens} → ${response.usage.output_tokens} tokens` : ""}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify({ ...response, output: undefined }, null, 2)}</pre>
    </details>
  </div>
}

const HistoryMessage = memo(function HistoryMessage({ language, record, workers }: { language: Language; record: HistoryRecord; workers: Worker[] | undefined }) {
  const { t } = useUi()
  const time = formattedTime(language, record.created_at)
  const action = threadControlAction(record)
  if (action) {
    const label = action === "cancel" ? t("threadStopped") : action === "continue" ? t("threadContinued") : t("threadCompactionRequested")
    return <Message><MessageContent><MessageFooter>{label} · {time}</MessageFooter></MessageContent></Message>
  }
  const imageSource = generatedImageSource(record.payload)
  if (imageSource) {
    return <Message>
      <MessageContent className="max-w-[75ch]">
        <img src={imageSource} alt={t("generatedImage")} loading="lazy" decoding="async" className="block h-auto max-w-full rounded-lg" />
        <MessageFooter>{t("generatedImage")} · #{record.id} · {time}</MessageFooter>
      </MessageContent>
    </Message>
  }
  const text = historyRecordText(record)
  const isUserInput = record.kind === "input"
  if (isUserInput) {
    return <Message align="end">
      <MessageContent>
        <MessageGroup>
          <div className="max-w-[75ch] whitespace-pre-wrap break-words rounded-lg bg-user-message px-3 py-2 text-sm leading-6 text-user-message-foreground">{text}</div>
        </MessageGroup>
        <MessageFooter>#{record.id} · {time}</MessageFooter>
      </MessageContent>
    </Message>
  }

  if (isReasoningRecord(record)) {
    const summary = reasoningSummary(record)
    return <div className="relative flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 dark:border-border dark:bg-card">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
        <SparklesIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-primary">{t("recordReasoning")}</span>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        {summary ? <div className="prose prose-sm mt-2 max-w-none break-words dark:prose-neutral dark:prose-invert prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown></div> : <p className="mt-2 text-sm text-muted-foreground">—</p>}
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>{t("recordPayload")}</span>
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <HistoryRecordPayload language={language} record={record} />
        </details>
      </div>
    </div>
  }

  const payload = historyPayloadObject(record.payload)
  if (record.kind === "response_output" && payload?.type === "message") {
    return <Message className="items-start">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
        <SparklesIcon className="size-4" />
      </div>
      <MessageContent className="gap-1.5">
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className="text-sm font-medium text-foreground">{t("assistant")}</span>
          <span aria-hidden="true">·</span>
          <time>{time}</time>
        </div>
        <div className="max-w-[75ch] rounded-2xl rounded-tl-md bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/10">
          <div className="prose prose-sm max-w-none break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
      </MessageContent>
    </Message>
  }

  if (record.kind === "tool_output") {
    return <div className="relative flex items-start gap-3 px-1">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
        <TerminalSquareIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{t("recordToolOutput")}</span>
          <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[0.68rem]">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            {t("worker")}
          </Badge>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{historyRecordSummary(text)}</p>
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>{t("recordPayload")}</span>
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <HistoryRecordPayload language={language} record={record} />
        </details>
      </div>
    </div>
  }

  const bashCall = bashFunctionCall(payload)
  if (bashCall) {
    return <BashCommand language={language} call={bashCall} workers={workers} time={time}>
      <details className="group mt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <span>{t("recordPayload")}</span>
          <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <HistoryRecordPayload language={language} record={record} />
      </details>
    </BashCommand>
  }

  if (record.kind === "checkpoint" || (typeof payload?.type === "string" && (payload.type !== "message" || !text.trim()))) {
    const Icon = record.kind === "checkpoint" ? DatabaseIcon : ActivityIcon
    return <div className="relative flex items-start gap-3 px-1">
      <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border/80">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-muted-foreground">{historyRecordLabel(record, t)}</span>
          <Badge variant="outline" className="h-5 px-1.5 text-[0.68rem] text-muted-foreground">{t("recordHidden")}</Badge>
          <time className="text-xs text-muted-foreground">{time}</time>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{historyRecordSummary(text)}</p>
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <span>{t("recordPayload")}</span>
            <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <HistoryRecordPayload language={language} record={record} />
        </details>
      </div>
    </div>
  }

  const isFailure = record.kind === "activity" && payload?.role === "system" && text.startsWith("Request failed:")
  return <div className={`flex items-start gap-3 rounded-xl border px-3 py-3 ${isFailure ? "border-destructive/35 bg-destructive/5" : "border-border/70 bg-card/70"}`}>
    <div aria-hidden="true" className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ${isFailure ? "bg-destructive/10 text-destructive ring-destructive/20" : "bg-muted text-muted-foreground ring-border/80"}`}>
      {isFailure ? <CircleAlertIcon className="size-4" /> : <ActivityIcon className="size-4" />}
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${isFailure ? "text-destructive" : ""}`}>{historyRecordLabel(record, t)}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{text}</div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground">
        <span className="font-mono">#{record.id}</span>
      </div>
    </div>
  </div>
}, (previous, next) => previous.workers === next.workers && previous.language === next.language && previous.record.id === next.record.id && previous.record.thread_id === next.record.thread_id && previous.record.kind === next.record.kind && previous.record.payload === next.record.payload && previous.record.created_at === next.record.created_at)

function historyRecordLabel(record: HistoryRecord, t: (key: CopyKey) => string) {
  if (isReasoningRecord(record)) return t("recordReasoning")
  if (record.kind === "tool_output") return t("recordToolOutput")
  if (record.kind === "activity") return t("recordActivity")
  if (record.kind === "checkpoint") return t("recordCheckpoint")
  return t("recordProtocol")
}

function isReasoningRecord(record: HistoryRecord) {
  return historyPayloadObject(record.payload)?.type === "reasoning"
}

function reasoningSummary(record: HistoryRecord) {
  const summary = historyPayloadObject(record.payload)?.summary
  if (!Array.isArray(summary)) return ""
  return summary
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text as string)
    .filter((text) => text.trim())
    .join("\n\n")
}

function historyRecordSummary(text: string) {
  const summary = text.replace(/\s+/g, " ").trim()
  if (!summary) return "—"
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary
}

function HistoryRecordPayload({ language, record }: { language: Language; record: HistoryRecord }) {
  return <div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-background/70">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/50 px-3 py-2 text-[0.68rem] text-muted-foreground">
      <code className="font-mono">#{record.id}</code>
      <time>{formattedTime(language, record.created_at)}</time>
    </div>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs leading-5 text-foreground">{historyRecordPayloadText(record)}</pre>
  </div>
}

function historyRecordPayloadText(record: HistoryRecord) {
  return JSON.stringify(record.payload, null, 2) ?? String(record.payload)
}

function historyRecordText(record: HistoryRecord) {
  return historyPayloadText(record.payload)
}

type ContextDraft = {
  id: string | null
  name: string
  description: string
  content: string
  parent_id: string | null
}

const ROOT_CONTEXT_VALUE = "__root__"

function contextDraft(context?: Context): ContextDraft {
  return {
    id: context?.id ?? null,
    name: context?.name ?? "",
    description: context?.description ?? "",
    content: context?.content ?? "",
    parent_id: context?.parent_id ?? null,
  }
}

function ContextsPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t } = useUi()
  const client = useQueryClient()
  const contexts = useQuery({ queryKey: ["contexts"], queryFn: () => api<Context[]>(sdk, "/api/contexts") })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ContextDraft | null>(null)
  const [initialized, setInitialized] = useState(false)
  const selected = contexts.data?.find((context) => context.id === selectedId)

  useEffect(() => {
    if (!contexts.data || initialized) return
    setInitialized(true)
    const first = contexts.data[0]
    setSelectedId(first?.id ?? null)
    setDraft(first ? contextDraft(first) : null)
  }, [contexts.data, initialized])

  const save = useMutation({
    mutationFn: (value: ContextDraft) => api<Context>(sdk, value.id ? `/api/contexts/${encodeURIComponent(value.id)}` : "/api/contexts", {
      method: value.id ? "PATCH" : "POST",
      body: JSON.stringify({
        name: value.name,
        description: value.description,
        content: value.content,
        parent_id: value.parent_id,
      }),
    }),
    onSuccess: (value) => {
      setSelectedId(value.id)
      setDraft(contextDraft(value))
      void client.invalidateQueries({ queryKey: ["contexts"] })
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<unknown>(sdk, `/api/contexts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_value, id) => {
      setSelectedId((current) => current === id ? null : current)
      setDraft(null)
      void client.invalidateQueries({ queryKey: ["contexts"] })
    },
  })

  function selectContext(context: Context) {
    setSelectedId(context.id)
    setDraft(contextDraft(context))
    save.reset()
    remove.reset()
  }

  function createNew() {
    setSelectedId(null)
    setDraft(contextDraft())
    save.reset()
    remove.reset()
  }

  function submit() {
    if (!draft || !draft.name.trim() || save.isPending) return
    save.mutate(draft)
  }

  function deleteSelected() {
    if (!draft?.id || remove.isPending || !window.confirm(`${t("deleteContextTitle")}\n\n${t("deleteContextDescription")}`)) return
    remove.mutate(draft.id)
  }

  return <Page title={t("contextsTitle")} description={t("contextsDescription")}>
    <div className="grid gap-6 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.6fr)]">
      <Card className="h-fit">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div><CardTitle>{t("contexts")}</CardTitle><CardDescription>{t("contextsDescription")}</CardDescription></div>
          <Button size="sm" variant="outline" onClick={createNew}><PlusIcon data-icon="inline-start" />{t("newContext")}</Button>
        </CardHeader>
        <CardContent>
          {contexts.error && <RequestError error={contexts.error} onRetry={() => void contexts.refetch()} />}
          {contexts.isLoading && <div className="flex flex-col gap-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>}
          {contexts.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("contextEmpty")}</p>}
          {contexts.data && contexts.data.length > 0 && <ContextTree contexts={contexts.data} selectedId={selectedId} onSelect={selectContext} label={t("contexts")} collapseLabel={t("contextCollapse")} expandLabel={t("contextExpand")} />}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{draft?.id ? t("editContext") : t("newContext")}</CardTitle><CardDescription>{t("contextsDescription")}</CardDescription></CardHeader>
        <CardContent>
          {draft ? <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); submit() }}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="context-name">{t("contextName")}</FieldLabel>
                <Input id="context-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("contextName")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="context-description">{t("contextDescription")}</FieldLabel>
                <Textarea id="context-description" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} />
              </Field>
              <Field>
                <FieldLabel htmlFor="context-content">{t("contextContent")}</FieldLabel>
                <Textarea id="context-content" className="min-h-56 font-mono text-sm" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="context-parent">{t("contextParent")}</FieldLabel>
                <Select value={draft.parent_id ?? ROOT_CONTEXT_VALUE} onValueChange={(value) => setDraft({ ...draft, parent_id: value === ROOT_CONTEXT_VALUE ? null : value })}>
                  <SelectTrigger id="context-parent"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROOT_CONTEXT_VALUE}>{t("contextRoot")}</SelectItem>
                    {contexts.data?.filter((context) => context.id !== draft.id).map((context) => <SelectItem key={context.id} value={context.id}>{context.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            {save.error && <RequestError error={save.error} onRetry={submit} />}
            {remove.error && <RequestError error={remove.error} />}
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={!draft.name.trim() || save.isPending}>{save.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{draft.id ? t("saveContext") : t("createContext")}</Button>
              {draft.id && <Button type="button" variant="destructive" disabled={remove.isPending} onClick={deleteSelected}>{remove.isPending ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}{t("deleteContext")}</Button>}
              {save.isSuccess && <span role="status" className="text-sm text-muted-foreground">{t("contextSaved")}</span>}
            </div>
          </form> : <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">{t("contextEmpty")}</div>}
          {selected && draft?.id === selected.id && <p className="mt-5 break-all font-mono text-xs text-muted-foreground">{selected.id}</p>}
        </CardContent>
      </Card>
    </div>
  </Page>
}

function ContextTree({ contexts, selectedId, onSelect, label, collapseLabel, expandLabel }: { contexts: Context[]; selectedId: string | null; onSelect: (context: Context) => void; label: string; collapseLabel: string; expandLabel: string }) {
  const children = useMemo(() => {
    const grouped = new Map<string | null, Context[]>()
    for (const context of contexts) grouped.set(context.parent_id, [...(grouped.get(context.parent_id) ?? []), context])
    for (const values of grouped.values()) values.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    return grouped
  }, [contexts])
  return <ul role="tree" aria-label={label} className="space-y-1">
    {(children.get(null) ?? []).map((context) => <ContextTreeNode key={context.id} context={context} children={children} selectedId={selectedId} onSelect={onSelect} collapseLabel={collapseLabel} expandLabel={expandLabel} />)}
  </ul>
}

function ContextTreeNode({ context, children, selectedId, onSelect, collapseLabel, expandLabel }: { context: Context; children: Map<string | null, Context[]>; selectedId: string | null; onSelect: (context: Context) => void; collapseLabel: string; expandLabel: string }) {
  const [expanded, setExpanded] = useState(true)
  const nested = children.get(context.id) ?? []
  return <li role="treeitem" aria-expanded={nested.length > 0 ? expanded : undefined}>
    <div className="flex items-center gap-1">
      <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" aria-label={expanded ? collapseLabel : expandLabel} disabled={nested.length === 0} onClick={() => setExpanded((value) => !value)}>
        {nested.length > 0 && <ChevronDownIcon className={expanded ? "" : "-rotate-90"} />}
      </Button>
      <Button type="button" variant="ghost" className={`h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left ${selectedId === context.id ? "bg-accent" : ""}`} onClick={() => onSelect(context)}>
        <span className="min-w-0 truncate font-medium">{context.name}</span>
        {context.description && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{context.description}</span>}
      </Button>
    </div>
    {expanded && nested.length > 0 && <ul role="group" className="ml-5 border-l pl-2">{nested.map((child) => <ContextTreeNode key={child.id} context={child} children={children} selectedId={selectedId} onSelect={onSelect} collapseLabel={collapseLabel} expandLabel={expandLabel} />)}</ul>}
  </li>
}

function InsightsPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const [range, setRange] = useState<Insights["range"]>("7d")
  const [model, setModel] = useState("all")
  const [requestKind, setRequestKind] = useState("all")
  const query = useQuery({
    queryKey: ["insights", range, model, requestKind],
    queryFn: () => {
      const params = new URLSearchParams({ range })
      if (model !== "all") params.set("model", model)
      if (requestKind !== "all") params.set("request_kind", requestKind)
      return api<Insights>(sdk, `/api/insights?${params}`)
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
  const clear = () => { setRange("7d"); setModel("all"); setRequestKind("all") }
  if (query.error) return <Page title={t("inferenceStats")} description={t("inferenceStatsDescription")}><RequestError error={query.error} onRetry={() => void query.refetch()} /></Page>
  if (!query.data) return <Page title={t("inferenceStats")} description={t("inferenceStatsDescription")}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t("inferenceStats")}</CardContent></Card></Page>
  const data = query.data
  const tokenMetrics = [
    [t("statsCompletedRequests"), number(data.tokens.completed_requests)],
    [t("statsInputTokens"), number(data.tokens.input_tokens)],
    [t("statsOutputTokens"), number(data.tokens.output_tokens)],
    [t("statsTotalTokens"), number(data.tokens.total_tokens)],
    [t("statsCachedTokens"), number(data.tokens.cached_tokens)],
    [t("statsCacheRate"), rate(data.tokens.cache_hit_rate)],
    [t("statsInputOutputRatio"), ratio(data.tokens.input_output_ratio)],
  ]
  const outcomes: { label: string; count: number; variant: "outline" | "secondary" | "destructive" }[] = [
    { label: t("statsCalls"), count: data.requests.total, variant: "outline" },
    { label: t("statsCompleted"), count: data.requests.completed, variant: "secondary" },
    { label: t("statsInFlight"), count: data.requests.in_flight, variant: "secondary" },
    { label: t("statsFailed"), count: data.requests.failed, variant: "destructive" },
    { label: t("statsCancelled"), count: data.requests.cancelled, variant: "outline" },
  ]
  return <Page title={t("inferenceStats")} description={t("inferenceStatsDescription")}>
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 pt-6">
        <Select value={range} onValueChange={(value) => setRange(value as Insights["range"])}>
          <SelectTrigger aria-label={t("statsRange")} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="24h">{t("stats24h")}</SelectItem><SelectItem value="7d">{t("stats7d")}</SelectItem><SelectItem value="30d">{t("stats30d")}</SelectItem><SelectItem value="all">{t("statsAll")}</SelectItem></SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger aria-label={t("statsModel")} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t("statsAllModels")}</SelectItem>{data.dimensions.models.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={requestKind} onValueChange={setRequestKind}>
          <SelectTrigger aria-label={t("statsRequestKind")} size="sm"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t("statsAllRequestKinds")}</SelectItem>{data.dimensions.request_kinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={clear}><RefreshCwIcon data-icon="inline-start" />{t("statsClearFilters")}</Button>
      </CardContent>
    </Card>
    <p className="text-xs text-muted-foreground">{t("statsGenerated").replace("{time}", formattedTime(language, data.generated_at))}</p>
    <Card>
      <CardHeader><CardTitle>{t("statsTokenUsage")}</CardTitle><CardDescription>{t("statsByModel")}</CardDescription></CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">{tokenMetrics.map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd></div>)}</dl>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("statsByModel")}</CardTitle><CardDescription>{number(data.requests.total)} {t("statsCalls")}</CardDescription></CardHeader>
      <CardContent>
        {data.by_model.length === 0 ? <p className="py-6 text-sm text-muted-foreground">{t("statsNoData")}</p> : <div className="overflow-x-auto"><table className="w-full min-w-[66rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t("statsModel")}</th><th className="px-3 py-2 font-medium">{t("statsCalls")}</th><th className="px-3 py-2 font-medium">{t("statsInputTokens")}</th><th className="px-3 py-2 font-medium">{t("statsOutputTokens")}</th><th className="px-3 py-2 font-medium">{t("statsTotalTokens")}</th><th className="px-3 py-2 font-medium">{t("statsCachedTokens")}</th><th className="px-3 py-2 font-medium">{t("statsCacheRate")}</th><th className="px-3 py-2 font-medium">{t("statsInputOutputRatio")}</th></tr></thead><tbody className="divide-y">{data.by_model.map((item) => <tr key={item.model} className="align-top"><td className="px-3 py-3"><code>{item.model}</code><p className="mt-1 text-xs text-muted-foreground">{number(item.completed)} {t("statsCompleted")}</p></td><td className="px-3 py-3 font-mono tabular-nums">{number(item.calls)}<p className="mt-1 text-xs text-muted-foreground">{number(item.in_flight)} {t("statsInFlight")}</p></td><td className="px-3 py-3 font-mono tabular-nums">{number(item.input_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.output_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.total_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{number(item.cached_tokens)}</td><td className="px-3 py-3 font-mono tabular-nums">{rate(item.cache_hit_rate)}</td><td className="px-3 py-3 font-mono tabular-nums">{ratio(item.input_output_ratio)}</td></tr>)}</tbody></table></div>}
      </CardContent>
    </Card>
    <section className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>{t("statsRequests")}</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2">{outcomes.map(({ label, count, variant }) => <div className="flex items-center justify-between rounded-lg border px-3 py-2" key={label}><Badge variant={variant}>{label}</Badge><span className="font-mono text-sm tabular-nums">{number(count)}</span></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{t("statsWorkerBytes")}</CardTitle><CardDescription>{t("statsWorkerBytesDescription")}</CardDescription></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t("statsWorkerCalls")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.worker.calls)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("statsReadBytes")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.worker.read_bytes)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("statsWriteBytes")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.worker.write_bytes)}</dd></div></dl>{data.worker.by_worker.length === 0 ? <p className="mt-6 text-sm text-muted-foreground">{t("statsNoWorkers")}</p> : <div className="mt-6 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-2 py-2 font-medium">{t("statsWorker")}</th><th className="px-2 py-2 font-medium">{t("statsCalls")}</th><th className="px-2 py-2 font-medium">{t("statsReadBytes")}</th><th className="px-2 py-2 font-medium">{t("statsWriteBytes")}</th></tr></thead><tbody className="divide-y">{data.worker.by_worker.map((item) => <tr key={item.worker_id}><td className="px-2 py-2"><p>{item.worker_label}</p><code className="text-xs text-muted-foreground">{item.worker_id}</code></td><td className="px-2 py-2 font-mono tabular-nums">{number(item.calls)}</td><td className="px-2 py-2 font-mono tabular-nums">{formatBytes(item.read_bytes)}</td><td className="px-2 py-2 font-mono tabular-nums">{formatBytes(item.write_bytes)}</td></tr>)}</tbody></table></div>}</CardContent></Card>
    </section>
    <Card><CardHeader><CardTitle>{t("statsHistory")}</CardTitle></CardHeader><CardContent><dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-xs text-muted-foreground">{t("statsHistoryRecords")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.history.total_records)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("statsPayloadBytes")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatBytes(data.history.payload_bytes)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("statsCheckpoints")}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{number(data.history.checkpoint_count)}</dd></div><div><dt className="text-xs text-muted-foreground">{t("statsLatestRecord")}</dt><dd className="mt-1 text-sm font-medium">{formattedTime(language, data.history.latest_record_at)}</dd></div></dl></CardContent></Card>
  </Page>
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
      {query.data && query.data.items.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[56rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t("auditThread")}</th><th className="px-3 py-2 font-medium">{t("auditRequest")}</th><th className="px-3 py-2 font-medium">{t("auditStatus")}</th><th className="px-3 py-2 font-medium">{t("auditStarted")}</th><th className="px-3 py-2 font-medium">{t("auditFinished")}</th><th className="px-3 py-2 font-medium">{t("auditUsage")}</th><th className="px-3 py-2 font-medium" title={t("auditCacheRateDescription")}>{t("statsCacheRate")}</th><th className="px-3 py-2 font-medium">{t("auditLink")}</th></tr></thead><tbody className="divide-y">{query.data.items.map((item) => <tr key={item.id} className="align-top"><td className="max-w-56 px-3 py-3"><Link className="font-medium hover:underline" to={`/threads/${item.thread_id}`}>{item.thread_title || item.thread_id}</Link><p className="mt-1 truncate font-mono text-[0.7rem] text-muted-foreground">{item.thread_id}</p></td><td className="px-3 py-3"><code>{item.model}</code><p className="mt-1 text-xs text-muted-foreground">{item.request_kind}</p><p className="mt-1 font-mono text-[0.7rem] text-muted-foreground">{item.idx_head === null || item.idx_tail === null ? "idx —" : `idx #${item.idx_head}–#${item.idx_tail}`}</p></td><td className="px-3 py-3"><Badge variant={item.status === "failed" ? "destructive" : item.status === "in_flight" ? "secondary" : "outline"}>{auditStatusLabel(item.status, t)}</Badge>{item.error && <p className="mt-2 max-w-64 break-words text-xs text-destructive">{item.error}</p>}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.started_at)}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.finished_at)}</td><td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">{usageLabel(item)}</td><td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums">{auditCacheRate(item.input_tokens, item.cached_tokens, language)}</td><td className="max-w-40 px-3 py-3">{item.openai_lb_request_id ? <a href={openaiAuditUrl(item.openai_lb_request_id)} target="_blank" rel="noopener noreferrer" title={t("auditOpenLink")} className="inline-flex max-w-full items-start gap-1 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><code className="break-all text-xs">{item.openai_lb_request_id}</code><ExternalLinkIcon className="mt-0.5 size-3 shrink-0" aria-hidden="true" /><span className="sr-only">{t("auditOpenLink")}</span></a> : <span className="text-xs text-muted-foreground">—</span>}</td></tr>)}</tbody></table></div>}
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

function WorkerAuditPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const [status, setStatus] = useState<WorkerCallAudit["status"] | "all">("all")
  const [workerId, setWorkerId] = useState("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const workers = useQuery({ queryKey: ["workers"], queryFn: () => api<Worker[]>(sdk, "/api/workers"), refetchInterval: 5000 })
  const query = useQuery({
    queryKey: ["worker-calls", status, workerId, page, pageSize],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (status !== "all") params.set("status", status)
      if (workerId !== "all") params.set("worker_id", workerId)
      return api<WorkerCallAuditPage>(sdk, `/api/worker-calls?${params}`)
    },
    refetchInterval: 2000,
  })
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pageSize))
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])
  const rangeStart = query.data?.total ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = query.data ? rangeStart + query.data.items.length - 1 : 0
  const range = t("workerAuditRange").replace("{from}", String(rangeStart)).replace("{to}", String(rangeEnd)).replace("{total}", String(query.data?.total ?? 0))
  return <Page title={t("workerAudit")} description={t("workerAuditDescription")}>
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><CardTitle>{t("workerAudit")}</CardTitle><CardDescription>{t("workerAuditDescription")}</CardDescription></div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={status} onValueChange={(value) => { setStatus(value as WorkerCallAudit["status"] | "all"); setPage(1) }}>
            <SelectTrigger aria-label={t("auditStatus")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("auditAll")}</SelectItem><SelectItem value="queued">{t("workerQueued")}</SelectItem><SelectItem value="delivered">{t("workerDelivered")}</SelectItem><SelectItem value="completed">{t("workerCompleted")}</SelectItem><SelectItem value="failed">{t("workerFailed")}</SelectItem></SelectContent>
          </Select>
          <Select value={workerId} onValueChange={(value) => { setWorkerId(value); setPage(1) }}>
            <SelectTrigger aria-label={t("workers")} size="sm"><SelectValue placeholder={t("workers")} /></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("workers")}</SelectItem>{workers.data?.map((worker) => <SelectItem key={worker.id} value={worker.id}>{worker.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(1) }}>
            <SelectTrigger aria-label={t("pageSize")} size="sm"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {query.error && <RequestError error={query.error} onRetry={() => void query.refetch()} />}
        {!query.data && !query.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("workerAudit")}</div>}
        {query.data && query.data.items.length === 0 && <p className="py-8 text-sm text-muted-foreground">{t("workerAuditEmpty")}</p>}
        {query.data && query.data.items.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[58rem] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="px-3 py-2 font-medium">{t("workerCall")}</th><th className="px-3 py-2 font-medium">{t("workers")}</th><th className="px-3 py-2 font-medium">{t("auditThread")}</th><th className="px-3 py-2 font-medium">{t("auditStatus")}</th><th className="px-3 py-2 font-medium">{t("auditStarted")}</th><th className="px-3 py-2 font-medium">{t("workerResult")}</th></tr></thead><tbody className="divide-y">{query.data.items.map((item) => <tr key={item.id} className="align-top"><td className="px-3 py-3"><code>{item.name}</code><p className="mt-1 text-xs text-muted-foreground">{item.id}</p><details className="mt-2 max-w-64"><summary className="cursor-pointer text-xs text-muted-foreground">{t("workerArguments")}</summary><pre className="mt-1 whitespace-pre-wrap break-words text-xs">{JSON.stringify(item.arguments, null, 2)}</pre></details></td><td className="px-3 py-3"><p>{item.worker_label ?? item.worker_id}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{item.worker_id}</p></td><td className="px-3 py-3"><Link className="hover:underline" to={`/threads/${item.thread_id}`}>{item.thread_title || item.thread_id}</Link><p className="mt-1 font-mono text-xs text-muted-foreground">input #{item.input_record_id ?? "—"}</p></td><td className="px-3 py-3"><Badge variant={item.status === "failed" ? "destructive" : item.status === "completed" ? "outline" : "secondary"}>{workerCallStatusLabel(item.status, t)}</Badge>{item.error && <p className="mt-2 max-w-64 break-words text-xs text-destructive">{item.error}</p>}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formattedTime(language, item.created_at)}{item.completed_at && <><br />{formattedTime(language, item.completed_at)}</>}</td><td className="max-w-72 px-3 py-3"><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">{item.result === null ? "—" : JSON.stringify(item.result, null, 2)}</pre></td></tr>)}</tbody></table></div>}
        {query.data && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{range}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t("previous")}</Button><Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>{t("next")}</Button></div></div>}
      </CardContent>
    </Card>
  </Page>
}

function workerCallStatusLabel(status: WorkerCallAudit["status"], t: (key: CopyKey) => string) {
  return status === "queued" ? t("workerQueued") : status === "delivered" ? t("workerDelivered") : status === "completed" ? t("workerCompleted") : t("workerFailed")
}

function HistoryPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  return <Page title={t("history")} description={t("historyDescription")}><HistoryTable language={language} request={(path, signal) => api(sdk, path, { signal })} /></Page>
}

function SystemPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const query = useQuery({ queryKey: ["system-resources"], queryFn: () => api<SystemResources>(sdk, "/api/system/resources"), refetchInterval: 5000 })
  return <Page title={t("systemTitle")} description={t("systemDescription")}>
    {query.error && <RequestError error={query.error} onRetry={() => void query.refetch()} />}
    {!query.data && !query.error && <Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t("systemTitle")}</CardContent></Card>}
    {query.data && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <MetricCard label={t("cpu")} value={`${query.data.cpu.usage_percent.toFixed(1)}%`} detail={`${t("cpuLoad")} ${query.data.cpu.load_1m.toFixed(2)} · ${query.data.cpu.logical_cpus} ${t("logicalCpus")}`} progress={query.data.cpu.usage_percent} />
      <MetricCard label={t("memory")} value={`${formatBytes(query.data.memory.used_bytes)} / ${formatBytes(query.data.memory.total_bytes)}`} detail={`${t("memoryAvailable")} ${formatBytes(query.data.memory.available_bytes)} · ${t("processMemory")} ${formatBytes(query.data.memory.process_used_bytes)}`} progress={query.data.memory.usage_percent} />
      <MetricCard label={t("disk")} value={query.data.disk ? `${formatBytes(query.data.disk.used_bytes)} / ${formatBytes(query.data.disk.total_bytes)}` : "—"} detail={query.data.disk ? `${t("diskAvailable")} ${formatBytes(query.data.disk.available_bytes)} · ${query.data.disk.mount_point}` : t("unavailable")} progress={query.data.disk?.usage_percent} />
      <MetricCard label={t("sqlite")} value={formatBytes(query.data.sqlite.total_bytes)} detail={`${t("sqliteMain")} ${formatBytes(query.data.sqlite.main_bytes)} · ${t("sqliteWal")} ${formatBytes(query.data.sqlite.wal_bytes)} · ${t("sqliteShm")} ${formatBytes(query.data.sqlite.shm_bytes)}`} />
      <MetricCard label={t("process")} value={`PID ${query.data.process_id}`} detail={`v${query.data.process_version} · ${t("sampleInterval")} ${query.data.sample_interval_ms} ms`} />
      <MetricCard label={t("swap")} value={`${formatBytes(query.data.memory.swap_used_bytes)} / ${formatBytes(query.data.memory.swap_total_bytes)}`} detail={t("memoryAvailable")} progress={query.data.memory.swap_total_bytes ? query.data.memory.swap_used_bytes / query.data.memory.swap_total_bytes * 100 : 0} />
      <Card className="sm:col-span-2 xl:col-span-3">
        <CardHeader><CardTitle>{t("network")}</CardTitle><CardDescription>{t("sampled")}: {formattedTime(language, query.data.generated_at)} · {query.data.network.interfaces} {t("networkInterfaces")}</CardDescription></CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <NetworkMetric label={`${t("networkNow")} · ${t("networkReceive")}`} value={`${formatBytes(query.data.network.receive_bytes_per_second)}/s`} />
          <NetworkMetric label={`${t("networkNow")} · ${t("networkTransmit")}`} value={`${formatBytes(query.data.network.transmit_bytes_per_second)}/s`} />
          <NetworkMetric label={`${t("networkTotal")} · ${t("networkReceive")}`} value={formatBytes(query.data.network.total_received_bytes)} />
          <NetworkMetric label={`${t("networkTotal")} · ${t("networkTransmit")}`} value={formatBytes(query.data.network.total_transmitted_bytes)} />
        </CardContent>
      </Card>
      <Card className="sm:col-span-2 xl:col-span-3">
        <CardHeader><CardTitle>{t("sqlite")}</CardTitle><CardDescription>{t("database")}</CardDescription></CardHeader>
        <CardContent><dl className="grid gap-4 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">{t("sqliteFreelist")}</dt><dd className="mt-1 font-mono tabular-nums">{formatBytes(query.data.sqlite.freelist_bytes)} ({query.data.sqlite.freelist_percent.toFixed(1)}%)</dd></div><div><dt className="text-muted-foreground">{t("sqliteWal")}</dt><dd className="mt-1 font-mono tabular-nums">{formatBytes(query.data.sqlite.wal_bytes)}</dd></div><div><dt className="text-muted-foreground">{t("sqliteShm")}</dt><dd className="mt-1 font-mono tabular-nums">{formatBytes(query.data.sqlite.shm_bytes)}</dd></div></dl></CardContent>
      </Card>
    </div>}
  </Page>
}

function NetworkMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</p></div>
}

function MetricCard({ label, value, detail, progress }: { label: string; value: string; detail: string; progress?: number }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{detail}{progress !== undefined && <Progress className="mt-3" value={Math.max(0, Math.min(100, progress))} />}</CardContent></Card>
}

function ThreadDefaultsCard({ sdk }: { sdk: AuthMiniApi }) {
  const { t } = useUi()
  const client = useQueryClient()
  const queryKey = ["thread-defaults", sdk.session.getState().sessionId]
  const [draft, setDraft] = useState<ThreadDefaults | null>(null)
  const defaults = useQuery({ queryKey, queryFn: ({ signal }) => api<ThreadDefaults>(sdk, "/api/thread-defaults", { signal }) })
  const models = useOpenAiModels(sdk)
  const save = useMutation({
    mutationFn: (value: ThreadDefaults) => api<ThreadDefaults>(sdk, "/api/thread-defaults", { method: "PUT", body: JSON.stringify(value) }),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: (value) => {
      client.setQueryData(queryKey, value)
      setDraft(null)
    },
  })
  const value = draft ?? defaults.data
  const changed = value && defaults.data && (
    value.model !== defaults.data.model ||
    value.reasoning_effort !== defaults.data.reasoning_effort ||
    value.service_tier_fast !== defaults.data.service_tier_fast ||
    value.web_search !== defaults.data.web_search ||
    value.image_generation !== defaults.data.image_generation
  )
  function edit(next: ThreadDefaults) {
    setDraft(next)
    save.reset()
  }
  return <Card>
    <CardHeader><CardTitle>{t("threadDefaults")}</CardTitle><CardDescription>{t("threadDefaultsDescription")}</CardDescription></CardHeader>
    <CardContent>
      {defaults.error && <RequestError error={defaults.error} onRetry={() => void defaults.refetch()} />}
      {defaults.isLoading && <div className="flex flex-col gap-4"><Skeleton className="h-14" /><Skeleton className="h-14" /><Skeleton className="h-9 w-36" /></div>}
      {value && <form className="flex max-w-xl flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (changed && !save.isPending) save.mutate(value) }}>
        <FieldGroup>
          <Field data-disabled={save.isPending}>
            <FieldLabel htmlFor="default-thread-model">{t("model")}</FieldLabel>
            <Select value={value.model} disabled={save.isPending} onValueChange={(model) => edit({ ...value, model })}>
              <SelectTrigger id="default-thread-model"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>
                {modelOptions(models.data?.models ?? [], value.model).map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>
          </Field>
          <Field data-disabled={save.isPending}>
            <FieldLabel htmlFor="default-thread-reasoning">{t("reasoningEffort")}</FieldLabel>
            <Select value={value.reasoning_effort} disabled={save.isPending} onValueChange={(effort) => edit({ ...value, reasoning_effort: effort as ThreadDefaults["reasoning_effort"] })}>
              <SelectTrigger id="default-thread-reasoning"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{REASONING_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal" data-disabled={save.isPending}>
            <FieldContent>
              <FieldLabel htmlFor="default-thread-fast">{t("fastMode")}</FieldLabel>
              <FieldDescription id="default-thread-fast-description">{t("fastModeDescription")}</FieldDescription>
            </FieldContent>
            <Switch id="default-thread-fast" aria-describedby="default-thread-fast-description" checked={value.service_tier_fast} disabled={save.isPending} onCheckedChange={(fast) => edit({ ...value, service_tier_fast: fast })} />
          </Field>
          <Field orientation="horizontal" data-disabled={save.isPending}>
            <FieldContent>
              <FieldLabel htmlFor="default-thread-web-search">{t("toolWebSearch")}</FieldLabel>
              <FieldDescription id="default-thread-web-search-description">{t("webSearchDescription")}</FieldDescription>
            </FieldContent>
            <Switch id="default-thread-web-search" aria-describedby="default-thread-web-search-description" checked={value.web_search} disabled={save.isPending} onCheckedChange={(web_search) => edit({ ...value, web_search })} />
          </Field>
          <Field orientation="horizontal" data-disabled={save.isPending}>
            <FieldContent>
              <FieldLabel htmlFor="default-thread-image-generation">{t("toolImageGeneration")}</FieldLabel>
              <FieldDescription id="default-thread-image-generation-description">{t("imageGenerationDescription")}</FieldDescription>
            </FieldContent>
            <Switch id="default-thread-image-generation" aria-describedby="default-thread-image-generation-description" checked={value.image_generation} disabled={save.isPending} onCheckedChange={(image_generation) => edit({ ...value, image_generation })} />
          </Field>
        </FieldGroup>
        {save.error && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t("saveDefaultsError")}</AlertTitle><AlertDescription>{errorMessage(save.error)}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!changed || save.isPending}>{save.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{save.isPending ? t("savingDefaults") : t("saveDefaults")}</Button>
          <p role="status" className="text-sm text-muted-foreground">{save.isSuccess && t("defaultsSaved")}</p>
        </div>
      </form>}
    </CardContent>
  </Card>
}

function SystemConfigurationPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const sessionId = sdk.session.getState().sessionId
  return <Page title={t("systemConfiguration")} description={t("systemConfigurationDescription")}>
    <SystemConfiguration key={sessionId} language={language} sessionId={sessionId} request={(path, init) => api(sdk, path, init)} />
  </Page>
}

function ConfigurationPage({ sdk }: { sdk: AuthMiniApi }) {
  const { t, language } = useUi()
  const { session } = useAuthMini()
  const client = useQueryClient()
  const integrations = useQuery({ queryKey: ["integrations", "openai"], queryFn: () => api<IntegrationStatus>(sdk, "/api/integrations/openai") })
  const models = useOpenAiModels(sdk)
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  useEffect(() => {
    if (integrations.data) setBaseUrl(integrations.data.base_url)
  }, [integrations.data?.base_url])
  const save = useMutation({
    mutationFn: () => api<IntegrationStatus>(sdk, "/api/integrations/openai", {
      method: "PUT",
      body: JSON.stringify({ base_url: baseUrl, ...(apiKey.trim() ? { api_key: apiKey } : {}) }),
    }),
    onSuccess: (value) => {
      setApiKey("")
      client.setQueryData(["integrations", "openai"], value)
      void client.invalidateQueries({ queryKey: ["openai-models"] })
    },
  })
  const changed = integrations.data && (baseUrl.trim() !== integrations.data.base_url || Boolean(apiKey.trim()))
  return <Page title={t("configuration")} description={t("configurationDescription")}>
    <ThreadDefaultsCard key={session?.sessionId} sdk={sdk} />
    <Card><CardHeader><CardTitle>{t("integration")}</CardTitle><CardDescription>{t("integrationDescription")}</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
      {integrations.error && <div className="sm:col-span-2"><RequestError error={integrations.error} onRetry={() => void integrations.refetch()} /></div>}
      {integrations.data && <div className="sm:col-span-2"><IntegrationRow label={t("openai")} configured={integrations.data.api_key_configured} detail={integrations.data.api_key_configured ? t("apiKeyConfigured") : t("notConfigured")} /></div>}
      {!integrations.data && !integrations.error && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("integration")}</div>}
      {integrations.data && <form className="sm:col-span-2 flex max-w-xl flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (changed && !save.isPending) save.mutate() }}>
        <FieldGroup>
          <Field data-disabled={save.isPending}>
            <FieldLabel htmlFor="openai-base-url">{t("apiBaseUrl")}</FieldLabel>
            <FieldDescription>{t("apiBaseUrlDescription")}</FieldDescription>
            <Input id="openai-base-url" type="url" value={baseUrl} disabled={save.isPending} onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>
          <Field data-disabled={save.isPending}>
            <FieldLabel htmlFor="openai-api-key">{t("apiKey")}</FieldLabel>
            <FieldDescription>{t("apiKeyDescription")}</FieldDescription>
            <Input id="openai-api-key" type="password" autoComplete="new-password" value={apiKey} placeholder={t("apiKeyPlaceholder")} disabled={save.isPending} onChange={(event) => setApiKey(event.target.value)} />
          </Field>
        </FieldGroup>
        {save.error && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t("apiConfigSaveError")}</AlertTitle><AlertDescription>{errorMessage(save.error)}</AlertDescription></Alert>}
        <div className="flex flex-wrap items-center gap-3"><Button disabled={!changed || save.isPending}>{save.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{save.isPending ? t("savingApiConfig") : t("saveApiConfig")}</Button><p role="status" className="text-sm text-muted-foreground">{save.isSuccess && t("apiConfigSaved")}</p></div>
      </form>}
      <div className="sm:col-span-2 flex max-w-xl flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-sm font-medium">{t("availableModels")}</p><p className="mt-1 text-sm text-muted-foreground">{t("availableModelsDescription")}</p></div>
          <Button type="button" size="sm" variant="outline" disabled={models.isFetching} onClick={() => void models.refetch()}>{models.isFetching ? <Spinner /> : <RefreshCwIcon data-icon="inline-start" />}{t("refreshModels")}</Button>
        </div>
        {models.isError && <p className="text-sm text-destructive">{errorMessage(models.error)}</p>}
        {models.isFetching && !models.data && <Skeleton className="h-6 w-64" />}
        {models.data && (models.data.models.length > 0
          ? <div className="flex flex-wrap gap-1.5">{models.data.models.map((model) => <Badge key={model} variant="outline">{model}</Badge>)}</div>
          : <p className="text-sm text-muted-foreground">{t("noModels")}</p>)}
      </div>
    </CardContent></Card>
    <LinkitNotifications language={language} sessionId={session?.sessionId} request={(path, init) => api(sdk, path, init)} />
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
  const { language } = useUi()
  return <WorkerConnections key={sdk.session.getState().sessionId} language={language} sessionId={sdk.session.getState().sessionId} request={(path, init) => api(sdk, path, init)} />
}

function ToolsPage() {
  const { t } = useUi()
  const tools = [
    { label: t("toolBash"), detail: "bash", provider: "Worker" },
    { label: t("toolBrowser"), detail: "browser_control", provider: "Worker" },
    { label: t("toolComputer"), detail: "computer_use", provider: "Worker" },
    { label: t("toolWebSearch"), detail: "web_search", provider: t("toolOpenAi") },
    { label: t("toolImageGeneration"), detail: "image_generation", provider: t("toolOpenAi") },
  ]
  return <Page title={t("tools")} description={t("toolsDescription")}><Card><CardContent className="divide-y p-0">{tools.map((tool) => <div className="flex items-center gap-3 px-4 py-4" key={tool.detail}><WrenchIcon className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{tool.label}</p><code className="text-xs text-muted-foreground">{tool.detail}</code></div><Badge variant="outline">{tool.provider}</Badge></div>)}</CardContent></Card></Page>
}

function SecretValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="flex items-start gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs leading-5 text-foreground">{value}</code><Button size="icon-sm" variant="outline" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>{copied ? <CheckIcon /> : <CopyIcon />}</Button></div>
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
