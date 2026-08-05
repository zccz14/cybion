import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { createBrowserSdk } from 'auth-mini/sdk/browser'
import type { AuthMiniApi, SessionSnapshot } from 'auth-mini/sdk/browser'
import { ActivityIcon, ArrowLeftIcon, BookOpenIcon, CheckIcon, CircleStopIcon, CpuIcon, DatabaseIcon, FileIcon, FolderIcon, GitForkIcon, HardDriveIcon, KeyRoundIcon, LanguagesIcon, MemoryStickIcon, MicIcon, MonitorCogIcon, NetworkIcon, PanelLeftIcon, PlusIcon, RefreshCwIcon, SendIcon, ServerIcon, Settings2Icon, SquareIcon, TerminalSquareIcon, WrenchIcon, XIcon } from 'lucide-react'
import { createContext, FormEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles.css'

declare global { interface Window { __MOBIUS_AUTH_URL: string | null } }

type DeploymentRole = 'controller' | 'executor'
type Status = { machine_id: string; hostname: string; root_user_id: string; auth_url: string; openai_base_url: string; deployment_role: DeploymentRole }
type Settings = { default_model: string; subthread_model: string; voice_script_model: string; edge_tts_zh_voice: string; edge_tts_en_voice: string; openai_base_url: string; openai_api_key: string; deployment_role: DeploymentRole }
type UpdateStatus = { current_version: string; latest_version: string | null; state: 'checking' | 'current' | 'ready' | 'failed'; detail: string }
type Peer = { id: string; name: string; base_url: string; machine_id: string; hostname: string; deployment_role: DeploymentRole; filesystem_enabled: boolean; bash_enabled: boolean; created_at: string }
type DeviceToken = { id: string; label: string; filesystem_enabled: boolean; bash_enabled: boolean; created_at: string }
type CreatedDeviceToken = DeviceToken & { secret: string }
type FileEntry = { name: string; path: string; kind: 'file' | 'directory'; size: number }
type SystemResources = { sampled_at: number; sample_interval_ms: number; cpu: { usage_percent: number; load_1m: number; logical_cpus: number }; memory: { used_bytes: number; total_bytes: number; available_bytes: number; process_used_bytes: number; other_used_bytes: number; usage_percent: number; swap_used_bytes: number; swap_total_bytes: number }; network: { receive_bytes_per_second: number; transmit_bytes_per_second: number; interfaces: number }; disk: { mount_point: string; used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number } | null; sqlite: { main_bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number; freelist_bytes: number; freelist_percent: number } }
type GeneratedImage = { id: string; data: string }
type ChatMessage = { id?: number; role: string; content: string | null; images?: GeneratedImage[]; created_at?: string; duration_ms?: number; input_tokens?: number; output_tokens?: number }
type Transcription = { text: string }
type VoiceScript = { text: string }
type Skill = { name: string; description: string; directory: string }
type Skills = { directory: string; skills: Skill[] }
type AgentEvent = { type: 'status'; stage: 'queued' | 'running' | 'checkpointing'; message: string } | { type: 'checkpoint'; id: number; through_message_id: number } | { type: 'tool_call'; call_id: string; name: string; arguments: Record<string, unknown>; started_at?: string } | { type: 'tool_result'; call_id: string; name: string; added_lines: number | null; deleted_lines: number | null; output?: string; finished_at?: string } | { type: 'context'; input_tokens: number } | { type: 'complete'; message: ChatMessage } | { type: 'error'; error: string }
type ConversationItem = { kind: 'message'; id: string; message: ChatMessage; queued: boolean } | { kind: 'status'; id: string; stage: 'queued' | 'running' | 'checkpointing'; message: string } | { kind: 'tool'; call_id: string; name: string; arguments: Record<string, unknown>; complete: boolean; started_at?: string; finished_at?: string; added_lines?: number | null; deleted_lines?: number | null }
type ConversationRun = { id: string; user_message_id: number; status: 'running' | 'completed' | 'failed' | 'cancelled'; events: AgentEvent[] }
type ContextCheckpoint = { id: number; through_message_id: number; source_message_count: number; summary: string; created_at: string }
type ConversationState = { messages: ChatMessage[]; runs: ConversationRun[]; context: { history_messages: number; checkpoint: ContextCheckpoint | null } }
type Subthread = { id: string; title: string; task: string; status: 'queued' | 'running'; model: string; result: string | null; created_at: string; updated_at: string }
type MainThreadSummary = { status: 'idle' | 'running'; model: string; updated_at: string | null }
type ThreadIndex = { main_thread: MainThreadSummary; subthreads: Subthread[] }
type SubthreadEvent = { id: number; event: AgentEvent; created_at: string }
type SubthreadDetail = { thread: Subthread; events: SubthreadEvent[] }
type SubthreadStreamMessage = { type: 'event'; item: SubthreadEvent } | { type: 'reaped' } | { type: 'error'; error: string }
type Session = SessionSnapshot
type Language = 'en' | 'zh'
type ToolsetPreview = { id: 'filesystem' | 'bash' | 'web_search' | 'image_generation'; name: string; description: string; tools: string[]; enabled: boolean }
type Toolsets = { filesystem_enabled: boolean; bash_enabled: boolean; web_search_enabled: boolean; image_generation_enabled: boolean }
const words = {
  en: {
    machine: 'Machine', console: 'Console', machines: 'Machines', files: 'Files', resources: 'Resources', tools: 'Tools', skills: 'Skills', settings: 'Settings', connecting: 'Connecting…', loadingMachine: 'Loading machine', online: 'Online', light: 'Light', dark: 'Dark', signOut: 'Sign out', language: 'Language',
    consoleDescription: 'Agent activity is streamed as it happens.', context: 'Context', tokens: 'tokens', duration: 'Duration', seconds: 's', stop: 'Stop', startRecording: 'Start voice input', stopRecording: 'Stop voice input', transcribing: 'Transcribing…', agentWorking: 'Agent is working…', greeting: 'I am connected to this machine. Tell me the outcome you want to reach.', queued: 'Queued', completed: 'Completed', calling: 'Calling', listingFiles: 'Listing', listedFiles: 'Listed', readingFile: 'Reading', readFile: 'Read', writingFile: 'Editing', wroteFile: 'Edited', runningCommand: 'Running command', ranCommand: 'Ran command', searchingWeb: 'Searching the web', searchedWeb: 'Searched the web', reasoning: 'Reasoning', parameters: 'Parameters', generatingImage: 'Generating image', generatedImage: 'Generated image', addedLines: 'added', deletedLines: 'deleted', lines: 'lines', outcomePlaceholder: 'Describe the outcome you want…', queuedPlaceholder: 'Add a follow-up prompt to the queue…', composeHint: 'Enter to send · Shift+Enter for a new line · IME Enter confirms composition', queuedCount: 'queued',
    machinesTitle: 'Machines', machinesDescription: 'Connect Mobius servers to this operator.', enrolledMachines: 'Enrolled machines', noMachines: 'No remote machines enrolled.', addMachine: 'Add a machine', name: 'Name', mobiusUrl: 'Mobius URL', add: 'Add machine', remove: 'Remove',
    filesTitle: 'Files', filesDescription: 'Browse and edit the active machine.', refresh: 'Refresh', directory: 'Directory', selectFile: 'Select a file', save: 'Save',
    resourcesTitle: 'Resources', resourcesDescription: 'Live capacity and local database usage.', sampled: 'Sampled', cpu: 'CPU', memory: 'Memory', network: 'Network', disk: 'Disk', sqlite: 'SQLite database', load1m: '1m load', logicalCpus: 'Logical CPUs', processMemory: 'Mobius RSS', otherMemory: 'Other system usage', available: 'Available', swap: 'Swap', received: 'Received', transmitted: 'Transmitted', interfaces: 'Interfaces', mount: 'Mount', main: 'Main', wal: 'WAL', shm: 'SHM', reclaimable: 'Reclaimable', unavailable: 'Unavailable',
    settingsTitle: 'Settings', settingsDescription: 'Configure this machine\'s agent upstream, thread models, and reply announcements.', defaultModel: 'Default model', defaultModelDescription: 'Used by the next agent turn.', modelId: 'Model ID', modelHint: 'Use a model supported by the configured upstream.', voiceScriptModel: 'Voice announcement model', voiceScriptModelHint: 'Rewrites final replies into natural speech before playback.', chineseVoice: 'Chinese Edge voice', englishVoice: 'English Edge voice', edgeVoiceHint: 'Use an Edge Neural voice name, for example {voice}.', baseUrlDescription: 'Used for the next agent turn.', apiKeyDescription: 'Used for the next agent turn.', saveChanges: 'Save changes', requestFailed: 'Request failed', initializeMobius: 'Initialize Mobius', initializeDescription: 'Bind this machine to your Auth Mini identity and OpenAI-compatible upstream.', authMiniUrl: 'Auth Mini URL', continueAuth: 'Continue with Auth Mini', apiKey: 'OpenAI API key', baseUrl: 'Base URL', initialize: 'Initialize', returnMachine: 'Return to the machine', signInDescription: 'Sign in through the configured Auth Mini server.', toolsTitle: 'Toolsets', toolsDescription: 'Review and compose the capabilities available to the active agent.', preview: 'Managed', previewTitle: 'Toolset controls', previewDescription: 'Changes apply to new agent turns. Shell commands execute through bash on the active machine.', createToolset: 'Create toolset', toolset: 'Toolset', includedTools: 'Included tools', status: 'Status', scope: 'Scope', enabled: 'Enabled', disabled: 'Disabled', currentAgent: 'Current agent', activeTools: 'active tools', filesystemToolset: 'Filesystem access', filesystemToolsetDescription: 'Read and write files on the active machine.', shellToolset: 'Shell commands', shellToolsetDescription: 'Execute commands through bash on the active machine.', webSearchToolset: 'Web search', webSearchToolsetDescription: 'Search the public web through the configured OpenAI-compatible upstream.', imageGenerationToolset: 'Image generation', imageGenerationToolsetDescription: 'Generate and edit images through the configured OpenAI-compatible upstream.', systemScope: 'System', toolsetDetails: 'Toolset details', toolsetDetailsDescription: 'The selected toolset contributes its tools to the next agent turn.', createToolsetTitle: 'Create a toolset', createToolsetDescription: 'Persistence and agent binding will be added after this interaction model is approved.', toolsetName: 'Toolset name', toolsetDescription: 'Description',
    updatesTitle: 'Updates', updatesDescription: 'Mobius checks GitHub Releases at startup and every six hours. Downloads are verified before installation.', currentVersion: 'Current version', latestVersion: 'Latest version', checkForUpdates: 'Check for updates', checkingForUpdates: 'Checking for updates…', updateChecking: 'Checking', updateCurrent: 'Up to date', updateReady: 'Ready to install', updateFailed: 'Check failed', restartToInstall: 'Restart and install', restartingToInstall: 'Restarting to install…',
    skillsTitle: 'Skills', skillsDescription: 'Installed skills are watched and applied to the next agent API request.', skillsDirectory: 'Skills directory', installedSkills: 'Installed skills', noSkills: 'No SKILL.md files found.', skillDirectory: 'Installation directory',
    controller: 'Controller', executor: 'Tool executor', deploymentRole: 'Deployment role', controllerDescription: 'Runs the main thread, model inference, and local or remote tools.', executorDescription: 'Exposes local tools through device tokens and does not require a model upstream.', checkpoint: 'Checkpoint', fullHistory: 'full-history messages', activeInputs: 'active inputs', backgroundWork: 'background tasks', announceReplies: 'Speak results', continuousVoice: 'Continuous voice', mainThreadQueued: 'Queued in the main thread', mainThreadRunning: 'Compiling context', checkpointing: 'Creating checkpoint', executorOnly: 'This machine is a tool executor. Use a controller Mobius to call its tools.', deviceAccess: 'Device access', deviceAccessDescription: 'Create a scoped token for another Mobius controller. The secret is shown once.', createDeviceToken: 'Create device token', tokenLabel: 'Token label', allowFilesystem: 'Allow filesystem', allowBash: 'Allow Bash', tokenSecret: 'Copy this secret now', revoke: 'Revoke', deviceToken: 'Device token', capabilities: 'Capabilities', verifyMachine: 'Enrollment verifies the shared issuer and root user.', threads: 'Threads', threadsTitle: 'Threads', threadsDescription: 'The main thread stays first, followed by live subthreads that have not been reaped.', noActiveThreads: 'No active subthreads.', thread: 'Thread', threadTask: 'Task', threadModel: 'Model', threadUpdated: 'Updated', threadDetails: 'Thread details', threadDetailsDescription: 'Read-only history and live events from this subthread.', backToThreads: 'Back to threads', events: 'Events', noThreadEvents: 'No events yet.', event: 'Event', time: 'Time', details: 'Details', threadQueued: 'Queued', threadRunning: 'Running', threadIdle: 'Idle', mainThread: 'Main thread', mainThreadDescription: 'The single user thread that accepts prompts.', mainThreadModel: 'Main thread model', subthreadModel: 'Subthread model', mainThreadModelHint: 'Used only by the main conversation.', subthreadModelHint: 'Captured when each subthread is forked.',
  },
  zh: {
    machine: '机器', console: '控制台', machines: '机器', files: '文件', resources: '资源', tools: '工具', skills: '技能', settings: '设置', connecting: '正在连接…', loadingMachine: '正在加载机器', online: '在线', light: '亮色', dark: '深色', signOut: '退出登录', language: '语言',
    consoleDescription: '实时展示 Agent 的执行过程。', context: '上下文', tokens: 'tokens', duration: '用时', seconds: '秒', stop: '停止', startRecording: '开始语音输入', stopRecording: '停止语音输入', transcribing: '正在转写…', agentWorking: 'Agent 正在执行…', greeting: '我已连接到这台机器。请告诉我你想要达成的结果。', queued: '排队中', completed: '已完成', calling: '正在调用', listingFiles: '正在列出', listedFiles: '已列出', readingFile: '正在读取', readFile: '已读取', writingFile: '正在编辑', wroteFile: '已编辑', runningCommand: '正在运行命令', ranCommand: '已运行命令', searchingWeb: '正在搜索网页', searchedWeb: '已搜索网页', reasoning: '推理', parameters: '参数', generatingImage: '正在生成图片', generatedImage: '已生成图片', addedLines: '增加', deletedLines: '删除', lines: '行', outcomePlaceholder: '描述你想要的结果…', queuedPlaceholder: '追加一条后续提示词…', composeHint: 'Enter 发送 · Shift+Enter 换行 · 输入法确认候选时不会发送', queuedCount: '条排队中',
    machinesTitle: '机器', machinesDescription: '将 Mobius 服务器接入当前操作台。', enrolledMachines: '已接入机器', noMachines: '尚未接入远程机器。', addMachine: '添加机器', name: '名称', mobiusUrl: 'Mobius URL', add: '添加机器', remove: '移除',
    filesTitle: '文件', filesDescription: '浏览并编辑当前机器。', refresh: '刷新', directory: '目录', selectFile: '选择文件', save: '保存',
    resourcesTitle: '系统资源', resourcesDescription: '实时容量和本地数据库占用。', sampled: '采样时间', cpu: 'CPU', memory: '内存', network: '网络', disk: '磁盘', sqlite: 'SQLite 数据库', load1m: '1 分钟负载', logicalCpus: '逻辑核心', processMemory: 'Mobius RSS', otherMemory: '其他系统占用', available: '可用', swap: '交换分区', received: '接收', transmitted: '发送', interfaces: '网卡', mount: '挂载点', main: '主文件', wal: 'WAL', shm: 'SHM', reclaimable: '可回收', unavailable: '不可用',
    settingsTitle: '设置', settingsDescription: '配置当前机器的 Agent 上游、线程模型和结果朗读。', defaultModel: '默认模型', defaultModelDescription: '用于下一轮 Agent 对话。', modelId: '模型 ID', modelHint: '请输入当前上游支持的模型。', voiceScriptModel: '朗读模型', voiceScriptModelHint: '播放前将最终回复改写为自然口语。', chineseVoice: '中文 Edge 音色', englishVoice: '英文 Edge 音色', edgeVoiceHint: '使用 Edge Neural 音色名称，例如 {voice}。', baseUrlDescription: '用于下一轮 Agent 对话。', apiKeyDescription: '用于下一轮 Agent 对话。', saveChanges: '保存更改', requestFailed: '请求失败', initializeMobius: '初始化 Mobius', initializeDescription: '将此机器绑定到你的 Auth Mini 身份和 OpenAI 兼容上游。', authMiniUrl: 'Auth Mini 地址', continueAuth: '使用 Auth Mini 继续', apiKey: 'OpenAI API 密钥', baseUrl: '基础地址', initialize: '初始化', returnMachine: '返回机器', signInDescription: '通过已配置的 Auth Mini 服务登录。', toolsTitle: '工具集', toolsDescription: '查看并组合当前 Agent 可使用的能力。', preview: '已管理', previewTitle: '工具集控制', previewDescription: '更改会应用于新的 Agent 对话。Shell 命令会通过当前机器上的 bash 执行。', createToolset: '新建工具集', toolset: '工具集', includedTools: '包含工具', status: '状态', scope: '范围', enabled: '已启用', disabled: '已禁用', currentAgent: '当前 Agent', activeTools: '个已启用工具', filesystemToolset: '文件系统访问', filesystemToolsetDescription: '读取和写入当前机器上的文件。', shellToolset: 'Shell 命令', shellToolsetDescription: '通过当前机器上的 bash 执行命令。', webSearchToolset: '网页搜索', webSearchToolsetDescription: '通过已配置的 OpenAI 兼容上游搜索公开网页。', imageGenerationToolset: '图片生成', imageGenerationToolsetDescription: '通过已配置的 OpenAI 兼容上游生成和编辑图片。', systemScope: '系统', toolsetDetails: '工具集详情', toolsetDetailsDescription: '选中的工具集会在下一轮 Agent 对话中贡献相应工具。', createToolsetTitle: '新建工具集', createToolsetDescription: '在确认这套交互模型后，再接入持久化和 Agent 绑定。', toolsetName: '工具集名称', toolsetDescription: '说明',
    updatesTitle: '版本更新', updatesDescription: 'Mobius 会在启动时及每六小时检查 GitHub Release。安装前会校验下载内容。', currentVersion: '当前版本', latestVersion: '最新版本', checkForUpdates: '检查更新', checkingForUpdates: '正在检查更新…', updateChecking: '检查中', updateCurrent: '已是最新', updateReady: '可以安装', updateFailed: '检查失败', restartToInstall: '重启并安装', restartingToInstall: '正在重启安装…',
    skillsTitle: '技能', skillsDescription: '已安装的技能目录会被监听，并在下一次 Agent API 请求时生效。', skillsDirectory: '技能目录', installedSkills: '已安装技能', noSkills: '未找到 SKILL.md 文件。', skillDirectory: '安装目录',
    controller: '控制设备', executor: '工具执行设备', deploymentRole: '部署角色', controllerDescription: '运行主线程和模型推理，并调用本机或远程工具。', executorDescription: '通过设备 Token 暴露本机工具，不需要配置模型上游。', checkpoint: '上下文检查点', fullHistory: '条完整历史', activeInputs: '条输入处理中', backgroundWork: '个后台任务', announceReplies: '播报结果', continuousVoice: '连续语音', mainThreadQueued: '已进入主线程队列', mainThreadRunning: '正在编译上下文', checkpointing: '正在创建检查点', executorOnly: '这台机器是工具执行设备。请从控制设备上的 Mobius 调用它的工具。', deviceAccess: '设备访问授权', deviceAccessDescription: '为另一台 Mobius 控制设备创建权限受限的 Token；密钥只显示一次。', createDeviceToken: '创建设备 Token', tokenLabel: 'Token 名称', allowFilesystem: '允许文件系统', allowBash: '允许 Bash', tokenSecret: '请立即复制此密钥', revoke: '撤销', deviceToken: '设备 Token', capabilities: '能力', verifyMachine: '接入时会验证双方使用同一 issuer 和 root user。', threads: '线程', threadsTitle: '线程', threadsDescription: '主线程固定置顶，后面列出尚未回收的实时子线程。', noActiveThreads: '当前没有活动子线程。', thread: '线程', threadTask: '任务', threadModel: '模型', threadUpdated: '更新时间', threadDetails: '线程详情', threadDetailsDescription: '只读查看这个子线程的历史记录与实时事件。', backToThreads: '返回线程列表', events: '事件', noThreadEvents: '暂时没有事件。', event: '事件', time: '时间', details: '详情', threadQueued: '排队中', threadRunning: '运行中', threadIdle: '空闲', mainThread: '主线程', mainThreadDescription: '唯一可以接收 prompt 的用户主线程。', mainThreadModel: '主线程模型', subthreadModel: '子线程模型', mainThreadModelHint: '仅用于主对话。', subthreadModelHint: '每个子线程在 fork 时固化该模型。',
  },
} as const
type TranslationKey = keyof typeof words.en

const queryClient = new QueryClient()
const UiContext = createContext<{ dark: boolean; toggleTheme: () => void; language: Language; setLanguage: (language: Language) => void; t: (key: TranslationKey) => string } | null>(null)
const AuthContext = createContext<AuthMiniApi | null>(null)

function UiProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('mobius.language') === 'zh' ? 'zh' : 'en')
  const [dark, setDark] = useState(() => localStorage.getItem('mobius.theme') === 'dark' || (!localStorage.getItem('mobius.theme') && matchMedia('(prefers-color-scheme: dark)').matches))
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; localStorage.setItem('mobius.language', language) }, [language])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('mobius.theme', dark ? 'dark' : 'light') }, [dark])
  return <UiContext.Provider value={{ dark, toggleTheme: () => setDark((value) => !value), language, setLanguage, t: (key) => words[language][key] }}>{children}</UiContext.Provider>
}

function useUi() { const value = useContext(UiContext); if (!value) throw new Error('UI context is missing'); return value }
function useAuth() { const value = useContext(AuthContext); if (!value) throw new Error('Auth context is missing'); return value }
function anonymous(): Session { return { status: 'anonymous', authenticated: false, sessionId: null, accessToken: null, refreshToken: null, receivedAt: null, expiresAt: null } }
function useBrowserSession(sdk: AuthMiniApi | null) { const [session, setSession] = useState<Session>(() => sdk?.session.getState() ?? anonymous()); useEffect(() => { if (!sdk) return; setSession(sdk.session.getState()); return sdk.session.onChange(setSession) }, [sdk]); return session }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong.' }
function bytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}` }

let unauthorizedRefresh: Promise<string> | null = null

async function refreshAccessToken(sdk: AuthMiniApi) {
  if (!unauthorizedRefresh) unauthorizedRefresh = sdk.session.refresh().then((session) => {
    if (!session.accessToken) throw new Error('Auth Mini did not return an access token.')
    return session.accessToken
  }).finally(() => { unauthorizedRefresh = null })
  return unauthorizedRefresh
}

async function validAccessToken(sdk: AuthMiniApi) {
  const session = sdk.session.getState()
  if (!session.accessToken) throw new Error('The Auth Mini session is no longer authenticated.')
  const expiresAt = Date.parse(session.expiresAt ?? '')
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) return refreshAccessToken(sdk)
  return session.accessToken
}

async function authenticatedFetch(sdk: AuthMiniApi, path: string, init?: RequestInit) {
  const request = async (token: string) => fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init?.headers } })
  const accessToken = await validAccessToken(sdk)
  const response = await request(accessToken)
  if (response.status !== 401) return response
  const currentToken = await validAccessToken(sdk)
  return request(currentToken === accessToken ? await refreshAccessToken(sdk) : currentToken)
}

async function api<T>(path: string, sdk: AuthMiniApi, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(sdk, path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<T>
}

async function bootstrapApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<T>
}

async function transcribeAudio(sdk: AuthMiniApi, audio: Blob): Promise<Transcription> {
  const form = new FormData()
  form.append('file', audio, `recording.${audio.type.includes('mp4') || audio.type.includes('m4a') ? 'm4a' : 'webm'}`)
  const response = await authenticatedFetch(sdk, '/api/audio/transcriptions', { method: 'POST', body: form })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<Transcription>
}

function createVoiceScript(sdk: AuthMiniApi, content: string): Promise<VoiceScript> {
  return api<VoiceScript>('/api/audio/voice-script', sdk, { method: 'POST', body: JSON.stringify({ content }) })
}

async function createSpeech(sdk: AuthMiniApi, text: string, language: Language): Promise<Blob> {
  const response = await authenticatedFetch(sdk, '/api/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language }) })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const audio = await response.blob()
  if (!audio.size) throw new Error('Edge TTS returned an empty audio response.')
  return audio
}

async function streamAgentTurn(sdk: AuthMiniApi, runId: string, message: ChatMessage, signal: AbortSignal, onEvent: (event: AgentEvent) => void) {
  const response = await authenticatedFetch(sdk, '/api/agent/turn', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, message }) })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const reader = response.body?.getReader(); if (!reader) throw new Error('The agent did not start an event stream.')
  const decoder = new TextDecoder(); let buffer = ''
  for (;;) { const { done, value } = await reader.read(); if (done) return; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const event = JSON.parse(line.slice(6)) as AgentEvent; onEvent(event); if (event.type === 'error') throw new Error(event.error) } }
}

async function streamSubthreadEvents(sdk: AuthMiniApi, threadId: string, after: number, signal: AbortSignal, onMessage: (message: SubthreadStreamMessage) => void) {
  const response = await authenticatedFetch(sdk, `/api/threads/${threadId}/events?after=${after}`, { signal })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const reader = response.body?.getReader(); if (!reader) throw new Error('The subthread did not start an event stream.')
  const decoder = new TextDecoder(); let buffer = ''
  for (;;) { const { done, value } = await reader.read(); if (done) throw new Error('The subthread event stream ended.'); buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const item = JSON.parse(line.slice(6)) as SubthreadStreamMessage; onMessage(item); if (item.type === 'reaped') return; if (item.type === 'error') throw new Error(item.error) } }
}

function normalizedAuthUrl(authUrl: string) { const url = new URL(authUrl.trim()); url.search = ''; url.hash = ''; url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`; return url.toString() }
function beginAuthRedirect(authUrl: string) { const normalized = normalizedAuthUrl(authUrl); const state = crypto.randomUUID(); sessionStorage.setItem('mobius.auth_url', normalized); sessionStorage.setItem('mobius.login_state', state); const callback = `${location.origin}${location.pathname}#/auth/callback`; const params = new URLSearchParams({ redirect_uri: callback, state }); if (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) params.set('aud', location.hostname); location.assign(`${normalized}web/#/login?${params.toString()}`) }
function acceptRedirectSession(): string | null { if (!location.hash.startsWith('#/auth/callback?')) return null; const params = new URLSearchParams(location.hash.slice('#/auth/callback?'.length)); const state = sessionStorage.getItem('mobius.login_state'); const authUrl = sessionStorage.getItem('mobius.auth_url'); if (!authUrl || !state || params.get('state') !== state) return null; const accessToken = params.get('access_token'); const sessionId = params.get('session_id'); const refreshToken = params.get('refresh_token'); const expiresIn = Number(params.get('expires_in')); if (!accessToken || !sessionId || !refreshToken || !Number.isFinite(expiresIn)) return null; const receivedAt = new Date(); localStorage.setItem(`auth-mini.sdk:${normalizedAuthUrl(authUrl)}`, JSON.stringify({ accessToken, sessionId, refreshToken, receivedAt: receivedAt.toISOString(), expiresAt: new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() })); sessionStorage.removeItem('mobius.login_state'); history.replaceState(null, '', `${location.pathname}${location.search}#/console`); return authUrl }

function App() { const authUrl = acceptRedirectSession() ?? window.__MOBIUS_AUTH_URL; const [sdk] = useState<AuthMiniApi | null>(() => authUrl ? createBrowserSdk(authUrl) : null); const session = useBrowserSession(sdk); if (!authUrl) return <Bootstrap session={session} />; if (session.status === 'recovering') return <main className="grid min-h-svh place-items-center"><Spinner /></main>; if (!sdk || !session.accessToken) return <SignIn />; return <AuthContext.Provider value={sdk}><Workspace /></AuthContext.Provider> }

function Bootstrap({ session }: { session: Session }) {
  const { t } = useUi()
  const [authUrl, setAuthUrl] = useState(() => sessionStorage.getItem('mobius.auth_url') ?? 'https://auth.ntnl.io')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://openai.ntnl.io/v1')
  const [role, setRole] = useState<DeploymentRole>('controller')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const signIn = () => { try { beginAuthRedirect(authUrl) } catch (cause) { setError(message(cause)) } }
  const setup = async (event: FormEvent) => {
    event.preventDefault()
    if (!session.accessToken) return
    setBusy(true)
    try {
      await bootstrapApi('/api/setup', session.accessToken, { method: 'POST', body: JSON.stringify({ auth_url: authUrl, openai_api_key: apiKey, openai_base_url: baseUrl, deployment_role: role }) })
      location.reload()
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-lg"><CardHeader><CardTitle>{t('initializeMobius')}</CardTitle><CardDescription>{t('initializeDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={setup}><FieldGroup><Field><FieldLabel>{t('deploymentRole')}</FieldLabel><Select value={role} onValueChange={(value) => setRole(value as DeploymentRole)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t('deploymentRole')}</SelectLabel><SelectItem value="controller">{t('controller')}</SelectItem><SelectItem value="executor">{t('executor')}</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</FieldDescription></Field><Field><FieldLabel htmlFor="auth-url">{t('authMiniUrl')}</FieldLabel><Input id="auth-url" value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} required /></Field><Button type="button" variant="secondary" onClick={signIn}><KeyRoundIcon data-icon="inline-start" />{t('continueAuth')}</Button>{role === 'controller' && <><Field><FieldLabel htmlFor="api-key">{t('apiKey')}</FieldLabel><Input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></Field><Field><FieldLabel htmlFor="base-url">{t('baseUrl')}</FieldLabel><Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field></>}</FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={busy || !session.authenticated}>{busy && <Spinner data-icon="inline-start" />}{t('initialize')}</Button></form></CardContent></Card></main>
}
function SignIn() { const { t } = useUi(); const [error, setError] = useState(''); return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-sm"><CardHeader><CardTitle>{t('returnMachine')}</CardTitle><CardDescription>{t('signInDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{error && <ErrorAlert error={error} />}<Button onClick={() => { try { beginAuthRedirect(window.__MOBIUS_AUTH_URL!) } catch (cause) { setError(message(cause)) } }}>{t('continueAuth')}</Button></CardContent></Card></main> }

type WorkspaceNavItem = { to: string; label: string; icon: typeof TerminalSquareIcon }

function WorkspaceNav({ nav }: { nav: WorkspaceNavItem[] }) {
  const { setOpenMobile } = useSidebar()
  return <SidebarMenu>{nav.map(({ to, label, icon: Icon }) => <SidebarMenuItem key={to}><SidebarMenuButton asChild tooltip={label}><NavLink to={to} onClick={() => setOpenMobile(false)} className={({ isActive }) => isActive ? 'font-medium' : ''}><Icon /><span>{label}</span></NavLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
}

function WorkspaceRoutes({ executor, token }: { executor: boolean; token: AuthMiniApi }) {
  return <Routes><Route path="/console" element={executor ? <Navigate to="/resources" replace /> : null} /><Route path="/threads" element={executor ? <Navigate to="/resources" replace /> : <ThreadsPage token={token} />} /><Route path="/threads/:id" element={executor ? <Navigate to="/resources" replace /> : <ThreadDetailPage token={token} />} /><Route path="/machines" element={<Machines token={token} />} /><Route path="/files" element={<FilesPage token={token} />} /><Route path="/resources" element={<ResourcesPage token={token} />} /><Route path="/tools" element={<ToolsetsPage token={token} />} /><Route path="/skills" element={<SkillsPage token={token} />} /><Route path="/settings" element={<SettingsPage token={token} />} /><Route path="*" element={<Navigate to={executor ? "/resources" : "/console"} replace />} /></Routes>
}

function Workspace() {
  const sdk = useAuth()
  const token = sdk
  const navigate = useNavigate()
  const { dark, language, setLanguage, toggleTheme, t } = useUi()
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status', token) })
  const operatorNav = [{ to: '/console', label: t('console'), icon: TerminalSquareIcon }, { to: '/threads', label: t('threads'), icon: GitForkIcon }]
  const machineNav = [{ to: '/machines', label: t('machines'), icon: NetworkIcon }, { to: '/files', label: t('files'), icon: FileIcon }, { to: '/resources', label: t('resources'), icon: ActivityIcon }, { to: '/tools', label: t('tools'), icon: WrenchIcon }, { to: '/skills', label: t('skills'), icon: BookOpenIcon }, { to: '/settings', label: t('settings'), icon: Settings2Icon }]
  const nav = status.data?.deployment_role === 'executor' ? machineNav : [...operatorNav, ...machineNav]
  const executor = status.data?.deployment_role === 'executor'
  return <SidebarProvider><Sidebar><SidebarHeader><div className="flex items-center gap-2.5 px-2 py-1 font-heading text-lg font-semibold"><img alt="" aria-hidden="true" className="size-6 shrink-0" src="/mobius-mark.png" />Mobius</div></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupLabel>{t('machine')}</SidebarGroupLabel><SidebarGroupContent><WorkspaceNav nav={nav} /></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter><div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><ServerIcon />{status.data?.hostname ?? t('connecting')}</div><DropdownMenu><DropdownMenuTrigger asChild><Button className="self-center" variant="ghost" size="icon-sm"><LanguagesIcon /><span className="sr-only">{t('language')}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={language} onValueChange={(value) => setLanguage(value as Language)}><DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem><DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><Button variant="ghost" size="sm" onClick={toggleTheme}><MonitorCogIcon data-icon="inline-start" />{dark ? t('light') : t('dark')}</Button><Button variant="ghost" size="sm" onClick={async () => { await sdk.session.logout(); navigate('/console') }}>{t('signOut')}</Button></SidebarFooter></Sidebar><SidebarInset className="h-svh overflow-hidden"><header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger><PanelLeftIcon /></SidebarTrigger><Separator orientation="vertical" className="h-4" /><div className="min-w-0"><p className="truncate text-sm font-medium">{status.data?.hostname ?? t('loadingMachine')}</p></div>{status.data && <Badge className="ml-auto" variant="outline">{executor ? t('executor') : t('controller')}</Badge>}<Badge variant="secondary">{t('online')}</Badge></header>{executor ? <div className="min-h-0 flex-1 overflow-y-auto"><WorkspaceRoutes executor token={token} /></div> : <Console token={token}><WorkspaceRoutes executor={false} token={token} /></Console>}</SidebarInset></SidebarProvider>
}

function conversationItems(state: ConversationState): ConversationItem[] {
  const runs = new Map<number, ConversationRun[]>()
  state.runs.forEach((run) => runs.set(run.user_message_id, [...(runs.get(run.user_message_id) ?? []), run]))
  return state.messages.flatMap((message) => {
    const entries: ConversationItem[] = [{ kind: 'message', id: message.id?.toString() ?? crypto.randomUUID(), message, queued: false }]
    if (message.role !== 'user' || message.id === undefined) return entries
    runs.get(message.id)?.forEach((run) => run.events.forEach((event, index) => {
      if (event.type === 'status') entries.push({ kind: 'status', id: `${run.id}-${index}`, stage: event.stage, message: event.message })
      if (event.type === 'checkpoint') entries.push({ kind: 'status', id: `${run.id}-${index}`, stage: 'checkpointing', message: `Checkpoint #${event.id}` })
      if (event.type === 'tool_call') entries.push({ kind: 'tool', call_id: event.call_id, name: event.name, arguments: event.arguments, complete: false, started_at: event.started_at })
      if (event.type === 'tool_result') {
        const tool = entries.find((entry): entry is Extract<ConversationItem, { kind: 'tool' }> => entry.kind === 'tool' && entry.call_id === event.call_id)
        if (tool) Object.assign(tool, { complete: true, finished_at: event.finished_at, added_lines: event.added_lines, deleted_lines: event.deleted_lines })
      }
    }))
    return entries
  })
}

function latestContextTokens(runs: ConversationRun[]) {
  for (const event of runs.flatMap((run) => run.events).reverse()) if (event.type === 'context') return event.input_tokens
  return null
}

function reasoningSummary(arguments_: Record<string, unknown>) {
  const summary = arguments_.summary
  if (!Array.isArray(summary)) return ''
  return summary.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const text = (item as { text?: unknown }).text
    return typeof text === 'string' ? [text] : []
  }).join('\n')
}

function runError(runs: ConversationRun[]) {
  const run = runs.at(-1)
  if (run?.status !== 'failed') return ''
  for (const event of [...run.events].reverse()) if (event.type === 'error') return event.error
  return ''
}

function formatTimestamp(language: Language, value: string) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

function threadStatusLabel(t: (key: TranslationKey) => string, status: Subthread['status']) {
  return t(status === 'queued' ? 'threadQueued' : 'threadRunning')
}

function mainThreadStatusLabel(t: (key: TranslationKey) => string, status: MainThreadSummary['status']) {
  return t(status === 'running' ? 'threadRunning' : 'threadIdle')
}

function subthreadConversationItems(thread: Subthread, events: SubthreadEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [{ kind: 'message', id: `${thread.id}-task`, message: { role: 'user', content: thread.task, created_at: thread.created_at }, queued: thread.status === 'queued' }]
  events.forEach(({ id, event }) => {
    if (event.type === 'status') items.push({ kind: 'status', id: `${thread.id}-${id}`, stage: event.stage, message: event.message })
    if (event.type === 'checkpoint') items.push({ kind: 'status', id: `${thread.id}-${id}`, stage: 'checkpointing', message: `Checkpoint #${event.id}` })
    if (event.type === 'tool_call') items.push({ kind: 'tool', call_id: event.call_id, name: event.name, arguments: event.arguments, complete: false, started_at: event.started_at })
    if (event.type === 'tool_result') {
      const tool = [...items].reverse().find((item): item is Extract<ConversationItem, { kind: 'tool' }> => item.kind === 'tool' && item.call_id === event.call_id)
      if (tool) Object.assign(tool, { complete: true, finished_at: event.finished_at, added_lines: event.added_lines, deleted_lines: event.deleted_lines })
    }
    if (event.type === 'complete') items.push({ kind: 'message', id: `${thread.id}-${id}`, message: event.message, queued: false })
  })
  return items
}

function ThreadsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const query = useQuery({ queryKey: ['threads'], queryFn: () => api<ThreadIndex>('/api/threads', token), refetchInterval: 1000 })
  if (query.error) return <Page title={t('threadsTitle')} description={t('threadsDescription')}><ErrorAlert error={message(query.error)} /></Page>
  return <Page title={t('threadsTitle')} description={t('threadsDescription')}><Card><CardHeader><CardTitle>{t('threadsTitle')}</CardTitle><CardDescription>{t('threadsDescription')}</CardDescription></CardHeader><CardContent>{!query.data ? <div className="flex items-center gap-2"><Spinner />{t('loadingMachine')}</div> : <Table><TableHeader><TableRow><TableHead>{t('thread')}</TableHead><TableHead>{t('status')}</TableHead><TableHead>{t('threadModel')}</TableHead><TableHead>{t('threadUpdated')}</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell><Button asChild className="h-auto p-0" variant="link"><Link to="/console">{t('mainThread')}</Link></Button><p className="max-w-md truncate text-xs text-muted-foreground">{t('mainThreadDescription')}</p></TableCell><TableCell><Badge variant={query.data.main_thread.status === 'running' ? 'secondary' : 'outline'}>{mainThreadStatusLabel(t, query.data.main_thread.status)}</Badge></TableCell><TableCell><code>{query.data.main_thread.model}</code></TableCell><TableCell>{query.data.main_thread.updated_at ? formatTimestamp(language, query.data.main_thread.updated_at) : '—'}</TableCell></TableRow>{query.data.subthreads.map((thread) => <TableRow key={thread.id}><TableCell><Button asChild className="h-auto p-0" variant="link"><Link to={`/threads/${thread.id}`}>{thread.title}</Link></Button><p className="max-w-md truncate text-xs text-muted-foreground" title={thread.task}>{thread.task}</p></TableCell><TableCell><Badge variant={thread.status === 'running' ? 'secondary' : 'outline'}>{threadStatusLabel(t, thread.status)}</Badge></TableCell><TableCell><code>{thread.model}</code></TableCell><TableCell>{formatTimestamp(language, thread.updated_at)}</TableCell></TableRow>)}</TableBody></Table>}</CardContent></Card></Page>
}

function ThreadDetailPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [streamError, setStreamError] = useState('')
  const query = useQuery({ queryKey: ['thread', id], queryFn: () => api<SubthreadDetail>(`/api/threads/${id}`, token), enabled: Boolean(id), retry: false })
  useEffect(() => { if (query.error && message(query.error) === 'subthread is no longer active') navigate('/threads', { replace: true }) }, [navigate, query.error])
  useEffect(() => {
    const detail = query.data
    if (!detail) return
    const threadId = detail.thread.id
    const controller = new AbortController()
    const after = detail.events.at(-1)?.id ?? 0
    setStreamError('')
    void streamSubthreadEvents(token, threadId, after, controller.signal, (item) => {
      if (item.type === 'event') {
        queryClient.setQueryData<SubthreadDetail>(['thread', threadId], (current) => !current || current.events.some((event) => event.id === item.item.id) ? current : { ...current, events: [...current.events, item.item] })
        return
      }
      if (item.type === 'reaped') {
        void queryClient.invalidateQueries({ queryKey: ['threads'] })
        navigate('/threads', { replace: true })
      }
    }).catch((cause) => { if (!controller.signal.aborted) setStreamError(message(cause)) })
    return () => controller.abort()
  }, [id, navigate, query.data?.thread.id, queryClient, token])
  if (query.error) return <Page title={t('threadDetails')} description={t('threadDetailsDescription')}><ErrorAlert error={message(query.error)} /></Page>
  if (!query.data) return <Page title={t('threadDetails')} description={t('threadDetailsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  const { thread, events } = query.data
  const conversation = subthreadConversationItems(thread, events)
  const eventError = [...events].reverse().find((item) => item.event.type === 'error')?.event
  const contextTokens = [...events].reverse().find((item) => item.event.type === 'context')?.event
  return <main className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><Button asChild variant="outline" size="sm"><Link to="/threads"><ArrowLeftIcon data-icon="inline-start" />{t('backToThreads')}</Link></Button><div className="min-w-0"><h1 className="truncate font-heading text-lg font-semibold">{thread.title}</h1><p className="text-sm text-muted-foreground">{t('threadDetailsDescription')}</p></div><Badge className="ml-auto" variant={thread.status === 'running' ? 'secondary' : 'outline'}>{threadStatusLabel(t, thread.status)}</Badge><Badge variant="outline">{thread.model}</Badge>{contextTokens?.type === 'context' && <Badge variant="outline">{t('context')}: {contextTokens.input_tokens.toLocaleString()} {t('tokens')}</Badge>}</div>{streamError && <div className="px-4 pt-4"><ErrorAlert error={streamError} /></div>}<ConversationFeed items={conversation} />{eventError?.type === 'error' && <div className="px-4 pb-4"><ErrorAlert error={eventError.error} /></div>}</main>
}

function ConversationFeed({ items }: { items: ConversationItem[] }) {
  const token = useAuth()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) })
  const [now, setNow] = useState(() => Date.now())
  const hasRunningTool = items.some((item) => item.kind === 'tool' && !item.complete && item.started_at)
  useEffect(() => {
    if (!hasRunningTool) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [hasRunningTool])
  return <MessageScrollerProvider autoScroll={false} defaultScrollPosition="end"><MessageScroller className="flex-1"><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl p-4">{items.map((item) => <MessageScrollerItem key={item.kind === 'tool' ? item.call_id : item.id} className="[content-visibility:visible] [contain-intrinsic-size:auto]"><ConversationEntry item={item} now={now} peers={peers.data ?? []} /></MessageScrollerItem>)}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" /></MessageScroller></MessageScrollerProvider>
}

function Console({ children, token }: { children: ReactNode; token: AuthMiniApi }) {
  const { language, t } = useUi()
  const location = useLocation()
  const queryClient = useQueryClient()
  const conversationQuery = useQuery({ queryKey: ['conversation'], queryFn: () => api<ConversationState>('/api/conversation', token), refetchOnWindowFocus: false })
  const threadsQuery = useQuery({ queryKey: ['threads'], queryFn: () => api<ThreadIndex>('/api/threads', token), refetchInterval: 1000 })
  const [conversation, setConversation] = useState<ConversationItem[]>([])
  const conversationRef = useRef(conversation)
  const activeRef = useRef(new Map<string, AbortController>())
  const recorderRef = useRef<MediaRecorder | null>(null)
  const continuousVoiceRef = useRef(false)
  const announceRef = useRef(localStorage.getItem('mobius.announce_replies') === 'true')
  const announcementRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const announcedMessageRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const [activeRuns, setActiveRuns] = useState<string[]>([])
  const [contextTokens, setContextTokens] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [continuousVoice, setContinuousVoice] = useState(continuousVoiceRef.current)
  const [announceReplies, setAnnounceReplies] = useState(announceRef.current)
  const [conversationInitialized, setConversationInitialized] = useState(false)
  const updateConversation = (next: ConversationItem[]) => { conversationRef.current = next; setConversation(next) }
  const activeSubthreads = threadsQuery.data?.subthreads.filter((thread) => thread.status === 'queued' || thread.status === 'running') ?? []

  useEffect(() => {
    if (!conversationQuery.data || activeRef.current.size > 0) return
    const latestAssistant = [...conversationQuery.data.messages].reverse().find((entry) => entry.role === 'assistant' && entry.id !== undefined)
    if (conversationInitialized && latestAssistant?.id !== announcedMessageRef.current) announce(latestAssistant?.content ?? null)
    announcedMessageRef.current = latestAssistant?.id ?? null
    updateConversation(conversationItems(conversationQuery.data))
    setContextTokens(latestContextTokens(conversationQuery.data.runs))
    setActiveRuns(conversationQuery.data.runs.filter((run) => run.status === 'running').map((run) => run.id))
    setConversationInitialized(true)
  }, [conversationQuery.data])
  useEffect(() => {
    if (!conversationQuery.data?.runs.some((run) => run.status === 'running') && activeSubthreads.length === 0) return
    const interval = window.setInterval(() => { void conversationQuery.refetch() }, 1000)
    return () => window.clearInterval(interval)
  }, [conversationQuery.data, activeSubthreads.length])
  useEffect(() => () => {
    continuousVoiceRef.current = false
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder?.state !== 'inactive') recorder?.stop()
    recorder?.stream.getTracks().forEach((track) => track.stop())
    activeRef.current.forEach((controller) => controller.abort())
    stopAnnouncements()
  }, [])

  function stopEdgeAudio() {
    const audio = audioRef.current
    audioRef.current = null
    if (audio) {
      audio.pause()
      URL.revokeObjectURL(audio.src)
      audio.removeAttribute('src')
    }
  }

  function stopAnnouncements() {
    announcementRef.current += 1
    stopEdgeAudio()
    window.speechSynthesis?.cancel()
  }

  function speak(content: string) {
    if (!announceRef.current || !content || !('speechSynthesis' in window)) return
    const utterance = new SpeechSynthesisUtterance(content)
    utterance.lang = language === 'zh' ? 'zh-CN' : 'en-US'
    window.speechSynthesis.speak(utterance)
  }

  function playEdgeSpeech(blob: Blob) {
    stopEdgeAudio()
    window.speechSynthesis?.cancel()
    const audio = new Audio(URL.createObjectURL(blob))
    audioRef.current = audio
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        URL.revokeObjectURL(audio.src)
        if (audioRef.current === audio) audioRef.current = null
      }
      audio.addEventListener('ended', () => { finish(); resolve() }, { once: true })
      audio.addEventListener('error', () => { finish(); reject(new Error('Edge TTS audio could not be played.')) }, { once: true })
      void audio.play().catch(() => { finish(); reject(new Error('Edge TTS audio could not be played.')) })
    })
  }

  function announce(content: string | null) {
    if (!announceRef.current || !content) return
    const announcement = ++announcementRef.current
    void createVoiceScript(token, content).then(async ({ text }) => {
      if (!announceRef.current || announcement !== announcementRef.current) return
      try {
        const audio = await createSpeech(token, text, language)
        if (!announceRef.current || announcement !== announcementRef.current) return
        await playEdgeSpeech(audio)
      } catch {
        if (announceRef.current && announcement === announcementRef.current) speak(text)
      }
    }).catch((cause: unknown) => setError(message(cause)))
  }

  const startRun = (entryId: string, input: ChatMessage) => {
    const runId = crypto.randomUUID()
    const controller = new AbortController()
    activeRef.current.set(runId, controller)
    setActiveRuns((runs) => [...runs, runId])
    setError('')
    void streamAgentTurn(token, runId, input, controller.signal, (event) => {
      if (event.type === 'status') {
        updateConversation([
          ...conversationRef.current.map((item) => item.kind === 'message' && item.id === entryId ? { ...item, queued: false } : item),
          { kind: 'status', id: `${runId}-${event.stage}-${crypto.randomUUID()}`, stage: event.stage, message: event.message },
        ])
      }
      if (event.type === 'checkpoint') updateConversation([...conversationRef.current, { kind: 'status', id: `${runId}-checkpoint-${event.id}`, stage: 'checkpointing', message: `Checkpoint #${event.id}` }])
      if (event.type === 'tool_call') updateConversation([...conversationRef.current, { kind: 'tool', call_id: event.call_id, name: event.name, arguments: event.arguments, complete: false, started_at: event.started_at }])
      if (event.type === 'tool_result') updateConversation(conversationRef.current.map((item) => item.kind === 'tool' && item.call_id === event.call_id ? { ...item, complete: true, finished_at: event.finished_at, added_lines: event.added_lines, deleted_lines: event.deleted_lines } : item))
      if (event.type === 'context') setContextTokens(event.input_tokens)
      if (event.type === 'complete') {
        updateConversation([...conversationRef.current, { kind: 'message', id: event.message.id?.toString() ?? crypto.randomUUID(), message: event.message, queued: false }])
        announcedMessageRef.current = event.message.id ?? null
        announce(event.message.content)
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(message(cause))
    }).finally(async () => {
      activeRef.current.delete(runId)
      setActiveRuns((runs) => runs.filter((id) => id !== runId))
      await queryClient.invalidateQueries({ queryKey: ['conversation'] })
      await queryClient.invalidateQueries({ queryKey: ['threads'] })
    })
  }

  const submitContent = (content: string) => {
    const text = content.trim()
    if (!text) return
    const entry: Extract<ConversationItem, { kind: 'message' }> = { kind: 'message', id: crypto.randomUUID(), message: { role: 'user', content: text }, queued: true }
    updateConversation([...conversationRef.current, entry])
    startRun(entry.id, entry.message)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = draftRef.current
    if (!input) return
    const content = input.value
    input.value = ''
    submitContent(content)
  }

  const stopAll = async () => {
    const controllers = [...activeRef.current.entries()]
    const runIds = [...new Set([...activeRuns, ...controllers.map(([id]) => id)])]
    activeRef.current.clear()
    controllers.forEach(([, controller]) => controller.abort())
    setActiveRuns([])
    await Promise.all(runIds.map((id) => api(`/api/agent/turn/${id}`, token, { method: 'DELETE' }).catch(() => undefined)))
    await queryClient.invalidateQueries({ queryKey: ['conversation'] })
  }

  const startRecording = async () => {
    if (recorderRef.current) return
    let stream: MediaStream | null = null
    try {
      const recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream = recordingStream
      const recorder = new MediaRecorder(recordingStream)
      const chunks: Blob[] = []
      let frame = 0
      let audioContext: AudioContext | null = null
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onstop = () => {
        if (recorderRef.current === recorder) recorderRef.current = null
        if (frame) cancelAnimationFrame(frame)
        void audioContext?.close()
        recordingStream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (!audio.size) {
          if (continuousVoiceRef.current) void startRecording()
          return
        }
        setTranscribing(true)
        void transcribeAudio(token, audio).then(({ text }) => {
          if (continuousVoiceRef.current) submitContent(text)
          else if (draftRef.current) draftRef.current.value = text
        }).catch((cause: unknown) => setError(message(cause))).finally(() => {
          setTranscribing(false)
          if (continuousVoiceRef.current) void startRecording()
        })
      }
      recorderRef.current = recorder
      recorder.start()
      setError('')
      setRecording(true)
      if (continuousVoiceRef.current) {
        audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        audioContext.createMediaStreamSource(recordingStream).connect(analyser)
        const samples = new Uint8Array(analyser.fftSize)
        const started = performance.now()
        let heardSpeech = false
        let lastSpeech = started
        const detectSilence = () => {
          if (recorder.state === 'inactive') return
          analyser.getByteTimeDomainData(samples)
          const energy = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length)
          const now = performance.now()
          if (energy > 0.035) { heardSpeech = true; lastSpeech = now }
          if ((heardSpeech && now - lastSpeech > 1200) || now - started > 30000) recorder.stop()
          else frame = requestAnimationFrame(detectSilence)
        }
        frame = requestAnimationFrame(detectSilence)
      }
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop())
      continuousVoiceRef.current = false
      setContinuousVoice(false)
      setError(message(cause))
    }
  }

  const toggleRecording = () => {
    const current = recorderRef.current
    if (current) {
      continuousVoiceRef.current = false
      setContinuousVoice(false)
      if (current.state !== 'inactive') current.stop()
      return
    }
    void startRecording()
  }

  const setContinuous = (enabled: boolean) => {
    continuousVoiceRef.current = enabled
    setContinuousVoice(enabled)
    if (enabled) void startRecording()
    else if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
  }

  const setAnnounce = (enabled: boolean) => {
    announceRef.current = enabled
    setAnnounceReplies(enabled)
    localStorage.setItem('mobius.announce_replies', enabled.toString())
    if (!enabled) stopAnnouncements()
  }

  const unavailable = conversationQuery.isLoading || Boolean(conversationQuery.error)
  const checkpoint = conversationQuery.data?.context.checkpoint
  const persistedError = conversationQuery.data ? runError(conversationQuery.data.runs) : ''
  const consoleSurface = <main className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><div><h1 className="font-heading text-lg font-semibold">{t('console')}</h1><p className="text-sm text-muted-foreground">{t('consoleDescription')}</p></div><Badge className="ml-auto" variant="outline">{t('context')}: {contextTokens?.toLocaleString() ?? '—'} {t('tokens')}</Badge><Badge variant="outline">{checkpoint ? `${t('checkpoint')} #${checkpoint.id}` : `${conversationQuery.data?.context.history_messages ?? 0} ${t('fullHistory')}`}</Badge>{activeRuns.length > 0 && <Badge variant="secondary">{activeRuns.length} {t('activeInputs')}</Badge>}{activeSubthreads.length > 0 && <Badge variant="secondary">{activeSubthreads.length} {t('backgroundWork')}</Badge>}{activeRuns.length > 0 && <Button variant="destructive" size="sm" onClick={() => void stopAll()}><CircleStopIcon data-icon="inline-start" />{t('stop')}</Button>}</div><div className="flex flex-wrap items-center gap-4 border-b px-4 py-2"><Field className="w-auto" orientation="horizontal"><Switch id="continuous-voice" checked={continuousVoice} onCheckedChange={setContinuous} /><FieldLabel htmlFor="continuous-voice">{t('continuousVoice')}</FieldLabel></Field><Field className="w-auto" orientation="horizontal"><Switch id="announce-replies" checked={announceReplies} onCheckedChange={setAnnounce} /><FieldLabel htmlFor="announce-replies">{t('announceReplies')}</FieldLabel></Field>{activeSubthreads.map((thread) => <div key={thread.id} className="flex items-center gap-2"><Badge variant="outline">{thread.title}</Badge><Button aria-label={`${t('stop')}: ${thread.title}`} size="icon-sm" variant="ghost" onClick={async () => { await api(`/api/threads/${thread.id}`, token, { method: 'DELETE' }); await threadsQuery.refetch() }}><XIcon /></Button></div>)}</div>{conversationInitialized ? <ConversationFeed items={conversation} /> : <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div>}{conversationQuery.error && <div className="px-4 pb-2"><ErrorAlert error={message(conversationQuery.error)} /></div>}{persistedError && <div className="px-4 pb-2"><ErrorAlert error={persistedError} /></div>}</main>
  return <><div className="min-h-0 flex-1 overflow-y-auto">{location.pathname === '/console' ? consoleSurface : children}</div>{error && <div className="shrink-0 px-4 pt-2"><ErrorAlert error={error} /></div>}<form className="shrink-0 border-t p-3" onSubmit={submit}><InputGroup className="mx-auto max-w-4xl"><InputGroupTextarea ref={draftRef} disabled={unavailable} onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }} onKeyDown={(event) => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return; event.preventDefault(); event.currentTarget.form?.requestSubmit() }} placeholder={activeRuns.length ? t('queuedPlaceholder') : t('outcomePlaceholder')} rows={2} /><InputGroupAddon align="inline-end"><InputGroupButton aria-label={recording ? t('stopRecording') : t('startRecording')} disabled={unavailable || transcribing} onClick={toggleRecording} size="icon-sm" variant={recording ? 'destructive' : 'ghost'}>{recording ? <SquareIcon /> : <MicIcon />}</InputGroupButton><InputGroupButton disabled={unavailable} type="submit" variant="default" size="icon-sm"><SendIcon /><span className="sr-only">{t('mainThread')}</span></InputGroupButton></InputGroupAddon></InputGroup><p className="mx-auto mt-1 max-w-4xl text-xs text-muted-foreground">{t('mainThread')}: {transcribing ? t('transcribing') : t('composeHint')}</p></form></>
}
function ConversationEntry({ item, now, peers }: { item: ConversationItem; now: number; peers: Peer[] }) {
  const { language, t } = useUi()
  if (item.kind === 'status') {
    const label = item.stage === 'queued' ? t('mainThreadQueued') : item.stage === 'checkpointing' ? t('checkpointing') : t('mainThreadRunning')
    return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline">{label}</Badge><span>{item.message}</span></div>
  }
  if (item.kind === 'tool') {
    const path = typeof item.arguments.path === 'string' ? item.arguments.path : ''
    const command = typeof item.arguments.command === 'string' ? item.arguments.command : ''
    const query = typeof item.arguments.query === 'string' ? item.arguments.query : ''
    const queries = Array.isArray(item.arguments.queries) ? item.arguments.queries.filter((value): value is string => typeof value === 'string').join(', ') : ''
    const summary = item.name === 'reasoning' ? reasoningSummary(item.arguments) : ''
    const targetDevice = item.arguments.target_device
    const targetDeviceLabel = typeof targetDevice !== 'string' ? '' : targetDevice === '' ? '【本机】' : peers.find((peer) => peer.machine_id === targetDevice)?.name ?? targetDevice
    const action = item.complete ? {
      list_files: t('listedFiles'), read_file: t('readFile'), write_file: t('wroteFile'), edit_file: t('wroteFile'), run_bash: t('ranCommand'), web_search: t('searchedWeb'), reasoning: t('reasoning'), image_generation: t('generatedImage'),
    }[item.name] : {
      list_files: t('listingFiles'), read_file: t('readingFile'), write_file: t('writingFile'), edit_file: t('writingFile'), run_bash: t('runningCommand'), web_search: t('searchingWeb'), reasoning: t('reasoning'), image_generation: t('generatingImage'),
    }[item.name]
    const target = command || path || query || queries || item.name
    const parameters = item.name === 'reasoning' ? '' : Object.keys(item.arguments).length ? JSON.stringify(targetDeviceLabel ? { ...item.arguments, target_device: targetDeviceLabel } : item.arguments) : ''
    const changes = item.complete && (item.name === 'write_file' || item.name === 'edit_file') && item.added_lines !== undefined && item.deleted_lines !== undefined ? ` · ${t('addedLines')} ${item.added_lines ?? 0} ${t('lines')} · ${t('deletedLines')} ${item.deleted_lines ?? 0} ${t('lines')}` : ''
    const started = item.started_at ? Date.parse(item.started_at) : NaN
    const finished = item.finished_at ? Date.parse(item.finished_at) : now
    const elapsed = Number.isNaN(started) ? null : Math.max(0, Math.floor((finished - started) / 1000))
    const duration = elapsed === null ? '' : ` · ${t('duration')}: ${elapsed} ${t('seconds')}`
    return <div className="flex items-start gap-2 text-sm text-muted-foreground">{item.complete ? item.name === 'run_bash' ? <TerminalSquareIcon className="mt-0.5 size-5 shrink-0 text-foreground" /> : <CheckIcon className="mt-0.5 size-4 text-foreground" /> : <Spinner className="mt-0.5" />}<div className="min-w-0 break-all">{summary ? <><span>{action ?? item.name}{duration}</span><div className="prose prose-sm mt-1 max-w-none text-foreground dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown></div></> : <><span>{action ?? item.name} <code className="font-mono text-foreground">{target}</code>{targetDeviceLabel && <> · {targetDeviceLabel}</>}{changes}{duration}</span>{parameters && <p className="mt-1 text-xs"><span>{t('parameters')}: </span><code className="font-mono text-foreground">{parameters}</code></p>}</>}</div></div>
  }
  if (item.message.role !== 'assistant') return <Message align="end"><MessageContent><Card size="sm"><CardContent className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></CardContent></Card></MessageContent></Message>
  const timestamp = item.message.created_at ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.message.created_at)) : null
  const duration = item.message.duration_ms === undefined ? null : `${t('duration')}: ${(item.message.duration_ms / 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })} ${t('seconds')}`
  const tokens = item.message.input_tokens === undefined || item.message.output_tokens === undefined ? null : `${(item.message.input_tokens + item.message.output_tokens).toLocaleString()} ${t('tokens')}`
  return <Message><MessageContent className="gap-1.5"><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></div>{item.message.images?.map((image) => <Card key={image.id} size="sm"><CardContent className="p-0"><img alt={t('generatedImage')} className="max-w-full" src={`data:image/png;base64,${image.data}`} /></CardContent></Card>)}<MessageFooter className="gap-2 px-0 font-normal">{[timestamp, duration, tokens].filter(Boolean).map((detail) => <span key={detail}>{detail}</span>)}</MessageFooter></MessageContent></Message>
}

function Machines({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) })
  const tokens = useQuery({ queryKey: ['device-tokens'], queryFn: () => api<DeviceToken[]>('/api/device-tokens', token) })
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [deviceToken, setDeviceToken] = useState('')
  const [tokenLabel, setTokenLabel] = useState('')
  const [allowFilesystem, setAllowFilesystem] = useState(true)
  const [allowBash, setAllowBash] = useState(true)
  const [createdSecret, setCreatedSecret] = useState('')
  const [error, setError] = useState('')
  const add = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api('/api/peers', token, { method: 'POST', body: JSON.stringify({ name, base_url: baseUrl, device_token: deviceToken }) })
      setName('')
      setBaseUrl('')
      setDeviceToken('')
      setError('')
      await peers.refetch()
    } catch (cause) { setError(message(cause)) }
  }
  const createToken = async (event: FormEvent) => {
    event.preventDefault()
    try {
      const created = await api<CreatedDeviceToken>('/api/device-tokens', token, { method: 'POST', body: JSON.stringify({ label: tokenLabel, filesystem_enabled: allowFilesystem, bash_enabled: allowBash }) })
      setCreatedSecret(created.secret)
      setTokenLabel('')
      setError('')
      await tokens.refetch()
    } catch (cause) { setError(message(cause)) }
  }
  return <Page title={t('machinesTitle')} description={t('machinesDescription')}>{error && <ErrorAlert error={error} />}{createdSecret && <Alert><KeyRoundIcon /><AlertTitle>{t('tokenSecret')}</AlertTitle><AlertDescription className="flex flex-col gap-3"><code className="break-all rounded-md bg-muted p-3 text-foreground">{createdSecret}</code><Button className="self-start" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(createdSecret)}>{t('save')}</Button></AlertDescription></Alert>}<div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader><CardTitle>{t('enrolledMachines')}</CardTitle><CardDescription>{t('verifyMachine')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{peers.data?.map((peer) => <div key={peer.id} className="flex items-start gap-3 rounded-lg border p-3"><ServerIcon /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{peer.name}</p><Badge variant="outline">{peer.deployment_role === 'executor' ? t('executor') : t('controller')}</Badge></div><p className="truncate text-sm text-muted-foreground">{peer.hostname} · {peer.base_url}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{peer.machine_id}</p><div className="mt-2 flex flex-wrap gap-2">{peer.filesystem_enabled && <Badge variant="secondary">filesystem</Badge>}{peer.bash_enabled && <Badge variant="secondary">bash</Badge>}</div></div><Button aria-label={`${t('refresh')}: ${peer.name}`} title={t('refresh')} variant="ghost" size="icon-sm" onClick={async () => { try { await api(`/api/peers/${peer.id}/status`, token); setError('') } catch (cause) { setError(message(cause)) } }}><RefreshCwIcon /></Button><Button aria-label={`${t('remove')}: ${peer.name}`} title={t('remove')} variant="ghost" size="icon-sm" onClick={async () => { await api(`/api/peers/${peer.id}`, token, { method: 'DELETE' }); await peers.refetch() }}><XIcon /></Button></div>)}{peers.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('noMachines')}</p>}</CardContent></Card><Card><CardHeader><CardTitle>{t('addMachine')}</CardTitle><CardDescription>{t('verifyMachine')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={add}><FieldGroup><Field><FieldLabel htmlFor="peer-name">{t('name')}</FieldLabel><Input id="peer-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field><FieldLabel htmlFor="peer-url">{t('mobiusUrl')}</FieldLabel><Input id="peer-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field><Field><FieldLabel htmlFor="peer-token">{t('deviceToken')}</FieldLabel><Input id="peer-token" type="password" value={deviceToken} onChange={(event) => setDeviceToken(event.target.value)} required /></Field></FieldGroup><Button><PlusIcon data-icon="inline-start" />{t('add')}</Button></form></CardContent></Card></div><Card><CardHeader><CardTitle>{t('deviceAccess')}</CardTitle><CardDescription>{t('deviceAccessDescription')}</CardDescription></CardHeader><CardContent className="grid gap-6 lg:grid-cols-2"><form className="flex flex-col gap-4" onSubmit={createToken}><FieldGroup><Field><FieldLabel htmlFor="token-label">{t('tokenLabel')}</FieldLabel><Input id="token-label" value={tokenLabel} onChange={(event) => setTokenLabel(event.target.value)} required /></Field><Field orientation="horizontal"><Switch id="token-filesystem" checked={allowFilesystem} onCheckedChange={setAllowFilesystem} /><FieldLabel htmlFor="token-filesystem">{t('allowFilesystem')}</FieldLabel></Field><Field orientation="horizontal"><Switch id="token-bash" checked={allowBash} onCheckedChange={setAllowBash} /><FieldLabel htmlFor="token-bash">{t('allowBash')}</FieldLabel></Field></FieldGroup><Button disabled={!allowFilesystem && !allowBash}><KeyRoundIcon data-icon="inline-start" />{t('createDeviceToken')}</Button></form><div className="flex flex-col gap-3">{tokens.data?.map((device) => <div key={device.id} className="flex items-center gap-3 rounded-lg border p-3"><KeyRoundIcon /><div className="min-w-0 flex-1"><p className="font-medium">{device.label}</p><div className="mt-1 flex flex-wrap gap-2">{device.filesystem_enabled && <Badge variant="secondary">filesystem</Badge>}{device.bash_enabled && <Badge variant="secondary">bash</Badge>}</div></div><Button aria-label={`${t('revoke')}: ${device.label}`} variant="ghost" size="icon-sm" onClick={async () => { await api(`/api/device-tokens/${device.id}`, token, { method: 'DELETE' }); await tokens.refetch() }}><XIcon /></Button></div>)}{tokens.data?.length === 0 && <p className="text-sm text-muted-foreground">—</p>}</div></CardContent></Card></Page>
}
function FilesPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const [path, setPath] = useState('/')
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [content, setContent] = useState('')
  const files = useQuery({ queryKey: ['files', path], queryFn: () => api<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`, token) })
  const open = async (entry: FileEntry) => { if (entry.kind === 'directory') { setPath(entry.path); return } setSelected(entry); const result = await api<{ content: string }>(`/api/files/read?path=${encodeURIComponent(entry.path)}`, token); setContent(result.content) }
  return <Page title={t('filesTitle')} description={t('filesDescription')}><Card><CardContent className="pt-4"><InputGroup><Input aria-label={t('directory')} value={path} onChange={(event) => setPath(event.target.value)} /><InputGroupAddon align="inline-end"><InputGroupButton onClick={() => files.refetch()}><RefreshCwIcon data-icon="inline-start" />{t('refresh')}</InputGroupButton></InputGroupAddon></InputGroup></CardContent></Card><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle>{t('directory')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-1">{files.data?.map((entry) => <Button key={entry.path} variant="ghost" className="justify-start" onClick={() => open(entry)}>{entry.kind === 'directory' ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />}{entry.name}</Button>)}</CardContent></Card><Card><CardHeader><CardTitle>{selected?.path ?? t('selectFile')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-3"><Textarea aria-label={selected?.path ?? t('selectFile')} value={content} onChange={(event) => setContent(event.target.value)} disabled={!selected} className="min-h-80 font-mono" /><Button disabled={!selected} onClick={() => selected && api('/api/files/write', token, { method: 'PUT', body: JSON.stringify({ path: selected.path, content }) })}>{t('save')}</Button></CardContent></Card></div></Page>
}

function ResourcesPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api<SystemResources>('/api/system/resources', token), refetchInterval: 5000 })
  if (resources.error) return <Page title={t('resourcesTitle')} description={t('resourcesDescription')}><ErrorAlert error={message(resources.error)} /></Page>
  if (!resources.data) return <Page title={t('resourcesTitle')} description={t('resourcesDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  const data = resources.data
  const percent = (value: number) => `${value.toFixed(1)}%`
  const sampledAt = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(data.sampled_at * 1000))
  const metrics = [
    { label: t('cpu'), icon: CpuIcon, value: percent(data.cpu.usage_percent), detail: `${t('load1m')}: ${data.cpu.load_1m.toFixed(2)} · ${t('logicalCpus')}: ${data.cpu.logical_cpus}`, percent: data.cpu.usage_percent },
    { label: t('memory'), icon: MemoryStickIcon, value: `${bytes(data.memory.used_bytes)} / ${bytes(data.memory.total_bytes)}`, detail: `${t('processMemory')}: ${bytes(data.memory.process_used_bytes)} · ${t('otherMemory')}: ${bytes(data.memory.other_used_bytes)} · ${t('available')}: ${bytes(data.memory.available_bytes)}`, secondary: `${t('swap')}: ${bytes(data.memory.swap_used_bytes)} / ${bytes(data.memory.swap_total_bytes)}`, percent: data.memory.usage_percent },
    { label: t('network'), icon: NetworkIcon, value: `${t('received')}: ${bytes(data.network.receive_bytes_per_second)}/s · ${t('transmitted')}: ${bytes(data.network.transmit_bytes_per_second)}/s`, detail: `${t('interfaces')}: ${data.network.interfaces}` },
    { label: t('disk'), icon: HardDriveIcon, value: data.disk ? `${bytes(data.disk.used_bytes)} / ${bytes(data.disk.total_bytes)}` : '—', detail: data.disk ? `${t('available')}: ${bytes(data.disk.available_bytes)} · ${t('mount')}: ${data.disk.mount_point}` : t('unavailable'), percent: data.disk?.usage_percent },
    { label: t('sqlite'), icon: DatabaseIcon, value: bytes(data.sqlite.total_bytes), detail: `${t('main')}: ${bytes(data.sqlite.main_bytes)} · ${t('wal')}: ${bytes(data.sqlite.wal_bytes)} · ${t('shm')}: ${bytes(data.sqlite.shm_bytes)}`, secondary: `${t('reclaimable')}: ${bytes(data.sqlite.freelist_bytes)} · ${percent(data.sqlite.freelist_percent)}`, percent: data.sqlite.freelist_percent },
  ]
  return <Page title={t('resourcesTitle')} description={t('resourcesDescription')}><Card><CardHeader><CardTitle>{t('resourcesTitle')}</CardTitle><CardDescription>{t('resourcesDescription')}</CardDescription><Badge className="mt-2 w-fit" variant="outline">{t('sampled')}: {sampledAt} · 5s</Badge></CardHeader><CardContent><dl className="overflow-hidden rounded-lg border"><div className="flex flex-col gap-4 p-4">{metrics.map(({ label, icon: Icon, value, detail, secondary, percent: usagePercent }) => <div key={label} className="grid gap-3 md:grid-cols-[minmax(9rem,0.75fr)_minmax(14rem,1fr)_minmax(16rem,1.5fr)] md:items-center"><dt className="flex items-center gap-2 font-medium"><Icon />{label}</dt><dd className="font-medium tabular-nums">{value}</dd><dd className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground"><span className="truncate" title={detail}>{detail}</span>{secondary && <span className="truncate font-medium text-foreground" title={secondary}>{secondary}</span>}{usagePercent !== undefined && <Progress aria-label={`${label}: ${percent(usagePercent)}`} value={Math.max(0, Math.min(100, usagePercent))} />}</dd></div>)}</div></dl></CardContent></Card></Page>
}

function SkillsPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const query = useQuery({ queryKey: ['skills'], queryFn: () => api<Skills>('/api/skills', token), refetchInterval: 2000 })
  if (query.error) return <Page title={t('skillsTitle')} description={t('skillsDescription')}><ErrorAlert error={message(query.error)} /></Page>
  if (!query.data) return <Page title={t('skillsTitle')} description={t('skillsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('skillsTitle')} description={t('skillsDescription')}><Card><CardHeader><CardTitle>{t('skillsDirectory')}</CardTitle><CardDescription><code>{query.data.directory}</code></CardDescription></CardHeader></Card><div className="grid gap-4 md:grid-cols-2">{query.data.skills.map((skill) => <Card key={skill.directory}><CardHeader><CardTitle>{skill.name}</CardTitle><CardDescription>{skill.description || '—'}</CardDescription></CardHeader><CardContent><p className="text-xs text-muted-foreground">{t('skillDirectory')}</p><code className="break-all text-sm">{skill.directory}</code></CardContent></Card>)}</div>{query.data.skills.length === 0 && <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('noSkills')}</CardContent></Card>}</Page>
}

function ToolsetsPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const toolsetsQuery = useQuery({ queryKey: ['toolsets'], queryFn: () => api<Toolsets>('/api/toolsets', token) })
  const [updateError, setUpdateError] = useState('')
  const [saving, setSaving] = useState(false)
  const filesystemEnabled = toolsetsQuery.data?.filesystem_enabled ?? false
  const bashEnabled = toolsetsQuery.data?.bash_enabled ?? false
  const webSearchEnabled = toolsetsQuery.data?.web_search_enabled ?? false
  const imageGenerationEnabled = toolsetsQuery.data?.image_generation_enabled ?? false
  const toolsets: ToolsetPreview[] = [
    { id: 'filesystem', name: t('filesystemToolset'), description: t('filesystemToolsetDescription'), tools: ['list_files', 'read_file', 'write_file', 'edit_file'], enabled: filesystemEnabled },
    { id: 'bash', name: t('shellToolset'), description: t('shellToolsetDescription'), tools: ['run_bash'], enabled: bashEnabled },
    { id: 'web_search', name: t('webSearchToolset'), description: t('webSearchToolsetDescription'), tools: ['web_search'], enabled: webSearchEnabled },
    { id: 'image_generation', name: t('imageGenerationToolset'), description: t('imageGenerationToolsetDescription'), tools: ['image_generation'], enabled: imageGenerationEnabled },
  ]
  const selected = toolsets.find((toolset) => toolset.enabled) ?? toolsets[0]
  const activeTools = toolsets.filter((toolset) => toolset.enabled).reduce((count, toolset) => count + toolset.tools.length, 0)
  const updateEnabled = async (id: ToolsetPreview['id'], enabled: boolean) => { setSaving(true); try { const next = await api<Toolsets>('/api/toolsets', token, { method: 'PUT', body: JSON.stringify({ filesystem_enabled: id === 'filesystem' ? enabled : filesystemEnabled, bash_enabled: id === 'bash' ? enabled : bashEnabled, web_search_enabled: id === 'web_search' ? enabled : webSearchEnabled, image_generation_enabled: id === 'image_generation' ? enabled : imageGenerationEnabled }) }); queryClient.setQueryData(['toolsets'], next); setUpdateError('') } catch (cause) { setUpdateError(message(cause)) } finally { setSaving(false) } }
  if (toolsetsQuery.error) return <Page title={t('toolsTitle')} description={t('toolsDescription')}><ErrorAlert error={message(toolsetsQuery.error)} /></Page>
  if (!toolsetsQuery.data) return <Page title={t('toolsTitle')} description={t('toolsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('toolsTitle')} description={t('toolsDescription')}><Alert><WrenchIcon /><AlertTitle>{t('previewTitle')}</AlertTitle><AlertDescription>{t('previewDescription')}</AlertDescription></Alert>{updateError && <ErrorAlert error={updateError} />}<Card><CardHeader><div className="flex flex-wrap items-center gap-2"><div className="flex-1"><CardTitle>{t('currentAgent')}</CardTitle><CardDescription>{activeTools} {t('activeTools')}</CardDescription></div><Badge variant="outline">{t('preview')}</Badge><Dialog><DialogTrigger asChild><Button><PlusIcon data-icon="inline-start" />{t('createToolset')}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{t('createToolsetTitle')}</DialogTitle><DialogDescription>{t('createToolsetDescription')}</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel htmlFor="toolset-name">{t('toolsetName')}</FieldLabel><Input id="toolset-name" disabled /></Field><Field><FieldLabel htmlFor="toolset-description">{t('toolsetDescription')}</FieldLabel><Textarea id="toolset-description" disabled /></Field></FieldGroup></DialogContent></Dialog></div></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>{t('toolset')}</TableHead><TableHead>{t('includedTools')}</TableHead><TableHead>{t('scope')}</TableHead><TableHead>{t('status')}</TableHead></TableRow></TableHeader><TableBody>{toolsets.map((toolset) => <TableRow key={toolset.id} data-state="selected"><TableCell>{toolset.name}</TableCell><TableCell>{toolset.tools.length}</TableCell><TableCell>{t('systemScope')}</TableCell><TableCell><div className="flex items-center gap-2"><Switch aria-label={`${toolset.name}: ${toolset.enabled ? t('enabled') : t('disabled')}`} checked={toolset.enabled} disabled={saving || toolsetsQuery.isFetching} onCheckedChange={(checked) => void updateEnabled(toolset.id, checked)} /><Badge variant={toolset.enabled ? 'secondary' : 'outline'}>{toolset.enabled ? t('enabled') : t('disabled')}</Badge></div></TableCell></TableRow>)}</TableBody></Table></CardContent></Card><Card><CardHeader><CardTitle>{t('toolsetDetails')}: {selected.name}</CardTitle><CardDescription>{t('toolsetDetailsDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><p className="text-sm text-muted-foreground">{selected.description}</p><div className="flex flex-wrap gap-2">{selected.tools.map((tool) => <Badge key={tool} variant="outline">{tool}</Badge>)}</div></CardContent></Card></Page>
}

function UpdatesCard({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const update = useQuery({ queryKey: ['update'], queryFn: () => api<UpdateStatus>('/api/update', token), refetchInterval: 5000 })
  const [checking, setChecking] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')
  const check = async () => {
    setChecking(true)
    try {
      const status = await api<UpdateStatus>('/api/update/check', token, { method: 'POST' })
      queryClient.setQueryData(['update'], status)
      setError('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setChecking(false)
    }
  }
  const restart = async () => {
    setRestarting(true)
    try {
      await api<{ restarting: boolean }>('/api/update/restart', token, { method: 'POST' })
      window.setTimeout(() => window.location.reload(), 1500)
    } catch (cause) {
      setError(message(cause))
      setRestarting(false)
    }
  }
  if (update.error) return <Card><CardHeader><CardTitle>{t('updatesTitle')}</CardTitle><CardDescription>{t('updatesDescription')}</CardDescription></CardHeader><CardContent><ErrorAlert error={message(update.error)} /></CardContent></Card>
  if (!update.data) return <Card><CardHeader><CardTitle>{t('updatesTitle')}</CardTitle><CardDescription>{t('updatesDescription')}</CardDescription></CardHeader><CardContent className="flex items-center gap-2"><Spinner />{t('checkingForUpdates')}</CardContent></Card>
  const status = update.data
  const labels: Record<UpdateStatus['state'], TranslationKey> = { checking: 'updateChecking', current: 'updateCurrent', ready: 'updateReady', failed: 'updateFailed' }
  const variant = status.state === 'failed' ? 'destructive' : status.state === 'ready' ? 'secondary' : 'outline'
  return <Card><CardHeader><div className="flex flex-wrap items-center gap-2"><div className="flex-1"><CardTitle>{t('updatesTitle')}</CardTitle><CardDescription>{t('updatesDescription')}</CardDescription></div><Badge variant={variant}>{t(labels[status.state])}</Badge></div></CardHeader><CardContent className="flex flex-col gap-4"><dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('currentVersion')}</dt><dd className="font-mono">v{status.current_version}</dd></div><div><dt className="text-muted-foreground">{t('latestVersion')}</dt><dd className="font-mono">{status.latest_version ?? '—'}</dd></div></dl><p className="text-sm text-muted-foreground">{status.detail}</p>{error && <ErrorAlert error={error} />}<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={checking || restarting} onClick={() => void check()}>{checking && <Spinner data-icon="inline-start" />}{checking ? t('checkingForUpdates') : t('checkForUpdates')}</Button>{status.state === 'ready' && <Button disabled={checking || restarting} onClick={() => void restart()}>{restarting ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}{restarting ? t('restartingToInstall') : t('restartToInstall')}</Button>}</div></CardContent></Card>
}

function SettingsPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings', token) })
  const [model, setModel] = useState('')
  const [subthreadModel, setSubthreadModel] = useState('')
  const [voiceScriptModel, setVoiceScriptModel] = useState('')
  const [zhVoice, setZhVoice] = useState('')
  const [enVoice, setEnVoice] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [role, setRole] = useState<DeploymentRole>('controller')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setModel(settings.data?.default_model ?? '')
    setSubthreadModel(settings.data?.subthread_model ?? '')
    setVoiceScriptModel(settings.data?.voice_script_model ?? '')
    setZhVoice(settings.data?.edge_tts_zh_voice ?? '')
    setEnVoice(settings.data?.edge_tts_en_voice ?? '')
    setBaseUrl(settings.data?.openai_base_url ?? '')
    setApiKey(settings.data?.openai_api_key ?? '')
    setRole(settings.data?.deployment_role ?? 'controller')
  }, [settings.data])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = await api<Settings>('/api/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ default_model: model, subthread_model: subthreadModel, voice_script_model: voiceScriptModel, edge_tts_zh_voice: zhVoice, edge_tts_en_voice: enVoice, openai_base_url: baseUrl, openai_api_key: apiKey, deployment_role: role }),
      })
      queryClient.setQueryData(['settings'], saved)
      await queryClient.invalidateQueries({ queryKey: ['status'] })
      setError('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  if (settings.error) return <Page title={t('settingsTitle')} description={t('settingsDescription')}><ErrorAlert error={message(settings.error)} /></Page>
  if (!settings.data) return <Page title={t('settingsTitle')} description={t('settingsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>

  return <Page title={t('settingsTitle')} description={t('settingsDescription')}><Card><CardHeader><CardTitle>{t('settingsTitle')}</CardTitle><CardDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={save}><FieldGroup><Field><FieldLabel>{t('deploymentRole')}</FieldLabel><Select value={role} onValueChange={(value) => setRole(value as DeploymentRole)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t('deploymentRole')}</SelectLabel><SelectItem value="controller">{t('controller')}</SelectItem><SelectItem value="executor">{t('executor')}</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</FieldDescription></Field>{role === 'controller' && <><Field><FieldLabel htmlFor="model">{t('mainThreadModel')}</FieldLabel><Input id="model" value={model} onChange={(event) => setModel(event.target.value)} required /><FieldDescription>{t('mainThreadModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="subthread-model">{t('subthreadModel')}</FieldLabel><Input id="subthread-model" value={subthreadModel} onChange={(event) => setSubthreadModel(event.target.value)} required /><FieldDescription>{t('subthreadModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="voice-script-model">{t('voiceScriptModel')}</FieldLabel><Input id="voice-script-model" value={voiceScriptModel} onChange={(event) => setVoiceScriptModel(event.target.value)} required /><FieldDescription>{t('voiceScriptModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="edge-tts-zh-voice">{t('chineseVoice')}</FieldLabel><Input id="edge-tts-zh-voice" value={zhVoice} onChange={(event) => setZhVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'zh-CN-XiaoxiaoNeural')}</FieldDescription></Field><Field><FieldLabel htmlFor="edge-tts-en-voice">{t('englishVoice')}</FieldLabel><Input id="edge-tts-en-voice" value={enVoice} onChange={(event) => setEnVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'en-US-JennyNeural')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-base-url">{t('baseUrl')}</FieldLabel><Input id="openai-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><FieldDescription>{t('baseUrlDescription')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-api-key">{t('apiKey')}</FieldLabel><Input id="openai-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /><FieldDescription>{t('apiKeyDescription')}</FieldDescription></Field></>}</FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{t('saveChanges')}</Button></form></CardContent></Card><UpdatesCard token={token} /></Page>
}
function Page({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6"><div><h1 className="font-heading text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>{children}</main> }
function ErrorAlert({ error }: { error: string }) { const { t } = useUi(); return <Alert variant="destructive"><AlertTitle>{t('requestFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><TooltipProvider><UiProvider><HashRouter><App /></HashRouter></UiProvider></TooltipProvider></QueryClientProvider>)
