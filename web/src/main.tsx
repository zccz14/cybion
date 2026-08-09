import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuthMiniApi } from 'auth-mini/sdk/browser'
import { AuthMiniButton, AuthMiniProvider, useAuthMini } from 'auth-mini-react-components'
import { ActivityIcon, ArrowLeftIcon, BookOpenIcon, CheckIcon, CircleStopIcon, CpuIcon, DatabaseIcon, FileIcon, FolderIcon, GitForkIcon, Globe2Icon, HardDriveIcon, KeyRoundIcon, LanguagesIcon, MemoryStickIcon, MicIcon, MonitorCogIcon, NetworkIcon, PanelLeftIcon, PlusIcon, RefreshCwIcon, SendIcon, ServerIcon, Settings2Icon, SquareIcon, TerminalSquareIcon, Volume2Icon, WrenchIcon, XIcon } from 'lucide-react'
import { createContext, FormEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import 'auth-mini-react-components/styles.css'

declare global { interface Window { __MOBIUS_AUTH_URL: string | null } }

type DeploymentRole = 'controller' | 'executor'
type Status = { machine_id: string; hostname: string; root_user_id: string; auth_url: string; openai_base_url: string; deployment_role: DeploymentRole }
type Settings = { default_model: string; subthread_model: string; voice_script_model: string; voice_script_max_chars: number; edge_tts_zh_voice: string; edge_tts_en_voice: string; openai_base_url: string; openai_api_key: string; deployment_role: DeploymentRole }
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
type AgentEvent = { type: 'status'; stage: 'queued' | 'running' | 'checkpointing' | 'retrying'; message: string } | { type: 'checkpoint'; id: number; through_message_id: number } | { type: 'tool_call'; call_id: string; name: string; arguments: Record<string, unknown>; started_at?: string } | { type: 'tool_result'; call_id: string; name: string; added_lines: number | null; deleted_lines: number | null; output?: string; finished_at?: string } | { type: 'context'; input_tokens: number } | { type: 'complete'; message: ChatMessage } | { type: 'error'; error: string }
type ConversationItem = { kind: 'message'; id: string; message: ChatMessage; queued: boolean } | { kind: 'status'; id: string; stage: 'queued' | 'running' | 'checkpointing' | 'retrying'; message: string } | { kind: 'tool'; call_id: string; name: string; arguments: Record<string, unknown>; complete: boolean; started_at?: string; finished_at?: string; added_lines?: number | null; deleted_lines?: number | null }
type ConversationRun = { id: string; user_message_id: number; status: 'running' | 'completed' | 'failed' | 'cancelled'; retry_attempt: number; next_retry_at: number | null; events: AgentEvent[] }
type ContextCheckpoint = { id: number; first_message_id: number; through_message_id: number; source_message_count: number; level: number; previous_checkpoint_id?: number; summary: string; created_at: string }
type ContextMemoryRoot = { facts: number; latest_checkpoint_id?: number; lookup_tool: string }
type ConversationState = { messages: ChatMessage[]; runs: ConversationRun[]; context: { history_messages: number; checkpoint: ContextCheckpoint | null; memory: ContextMemoryRoot } }
type Subthread = { id: string; title: string; task: string; status: 'queued' | 'running' | 'retrying'; model: string; result: string | null; retry_attempt: number; next_retry_at: number | null; created_at: string; updated_at: string }
type MainThreadSummary = { status: 'idle' | 'running' | 'retrying'; model: string; updated_at: string | null }
type ThreadIndex = { main_thread: MainThreadSummary; subthreads: Subthread[] }
type SubthreadEvent = { id: number; event: AgentEvent; created_at: string }
type SubthreadDetail = { thread: Subthread; events: SubthreadEvent[] }
type SubthreadStreamMessage = { type: 'event'; item: SubthreadEvent } | { type: 'reaped' } | { type: 'error'; error: string }
type Language = 'en' | 'zh'
type ToolDefinition = { type: string; name?: string; description?: string; parameters?: unknown }
type ToolCatalog = { tools: ToolDefinition[] }
type BrowserApproval = { id: string; description: string }
type BrowserSession = { id: string; computer_use_enabled: boolean; created_at: string; url: string; pending_approval?: BrowserApproval }
type CommandRun = { id: string; command: string; target_machine_id: string; target_machine_name: string; started_at: string; completed_at: string | null; result: string | null; exit_code: number | null; status: 'running' | 'cancelled' | 'complete' }
const words = {
  en: {
    machine: 'Machine', console: 'Console', machines: 'Machines', files: 'Files', commands: 'Commands', resources: 'Resources', tools: 'Tools', skills: 'Skills', settings: 'Settings', connecting: 'Connecting…', loadingMachine: 'Loading machine', online: 'Online', light: 'Light', dark: 'Dark', language: 'Language',
    consoleDescription: 'Agent activity is streamed as it happens.', context: 'Context', tokens: 'tokens', duration: 'Duration', seconds: 's', stop: 'Stop', startRecording: 'Start voice input', stopRecording: 'Stop voice input', transcribing: 'Transcribing…', agentWorking: 'Agent is working…', greeting: 'I am connected to this machine. Tell me the outcome you want to reach.', queued: 'Queued', completed: 'Completed', calling: 'Calling', listingFiles: 'Listing', listedFiles: 'Listed', readingFile: 'Reading', readFile: 'Read', writingFile: 'Editing', wroteFile: 'Edited', runningCommand: 'Running command', ranCommand: 'Ran command', searchingWeb: 'Searching the web', searchedWeb: 'Searched the web', reasoning: 'Reasoning', parameters: 'Parameters', generatingImage: 'Generating image', generatedImage: 'Generated image', addedLines: 'added', deletedLines: 'deleted', lines: 'lines', outcomePlaceholder: 'Describe the outcome you want…', queuedPlaceholder: 'Add a follow-up prompt to the queue…', composeHint: 'Enter to send · Shift+Enter for a new line · IME Enter confirms composition', queuedCount: 'queued',
    machinesTitle: 'Machines', machinesDescription: 'Connect Mobius servers to this operator.', enrolledMachines: 'Enrolled machines', noMachines: 'No remote machines enrolled.', addMachine: 'Add a machine', name: 'Name', mobiusUrl: 'Mobius URL', add: 'Add machine', remove: 'Remove', browser: 'Browser', browserTitle: 'Browser Control', browserDescription: 'Agents autonomously create and control disposable, isolated Chromium sessions.', browserCreateHint: 'Agents create unrestricted sessions when needed. Create one here only for manual takeover.', createBrowser: 'Create browser session', computerUse: 'Enable Computer Use', computerUseHint: 'Visual actions pause for explicit approval before clicks or typing.', noBrowserSessions: 'No browser sessions are active.', selectBrowser: 'Select browser session', noBrowser: 'No browser', closeBrowser: 'Close session', approveAction: 'Approve action', browserInput: 'Type into browser', sendBrowserInput: 'Send input', browserLiveView: 'Live browser view', browserClickHint: 'Click the preview to take over with direct pointer input. Scroll over it with a mouse or trackpad.',
    filesTitle: 'Files', filesDescription: 'Browse and edit the active machine.', refresh: 'Refresh', directory: 'Directory', selectFile: 'Select a file', save: 'Save',
    commandsTitle: 'Commands', commandsDescription: 'Every run_bash invocation is durably recorded. Running commands stay first.', noCommands: 'No commands have been run.', command: 'Command', commandTarget: 'Target machine', commandStartedAt: 'Started', commandFinishedAt: 'Finished', commandResult: 'Result', commandExitCode: 'Exit code', commandRunning: 'Running', commandCancelled: 'Cancelled', commandComplete: 'Complete',
    resourcesTitle: 'Resources', resourcesDescription: 'Live capacity and local database usage.', sampled: 'Sampled', cpu: 'CPU', memory: 'Memory', network: 'Network', disk: 'Disk', sqlite: 'SQLite database', load1m: '1m load', logicalCpus: 'Logical CPUs', processMemory: 'Mobius RSS', otherMemory: 'Other system usage', available: 'Available', swap: 'Swap', received: 'Received', transmitted: 'Transmitted', interfaces: 'Interfaces', mount: 'Mount', main: 'Main', wal: 'WAL', shm: 'SHM', reclaimable: 'Reclaimable', unavailable: 'Unavailable',
    settingsTitle: 'Settings', settingsDescription: 'Configure this machine\'s agent upstream, thread models, and reply announcements.', defaultModel: 'Default model', defaultModelDescription: 'Used by the next agent turn.', modelId: 'Model ID', modelHint: 'Use a model supported by the configured upstream.', voiceScriptModel: 'Voice announcement model', voiceScriptModelHint: 'Rewrites final replies into natural speech before playback.', voiceScriptLength: 'Voice announcement length', voiceScriptLengthHint: 'Maximum characters in the generated script. 150 characters is usually about 30 seconds.', chineseVoice: 'Chinese Edge voice', englishVoice: 'English Edge voice', edgeVoiceHint: 'Use an Edge Neural voice name, for example {voice}.', baseUrlDescription: 'Used for the next agent turn.', apiKeyDescription: 'Used for the next agent turn.', saveChanges: 'Save changes', requestFailed: 'Request failed', initializeMobius: 'Initialize Mobius', initializeDescription: 'Bind this machine to your Auth Mini identity and OpenAI-compatible upstream.', authMiniUrl: 'Auth Mini URL', continueAuth: 'Continue with Auth Mini', apiKey: 'OpenAI API key', baseUrl: 'Base URL', initialize: 'Initialize', returnMachine: 'Return to the machine', signInDescription: 'Sign in through the configured Auth Mini server.', toolsTitle: 'Tools', toolsDescription: 'Every tool sent with a main-thread Responses request.', toolName: 'Tool', toolDescription: 'Description', toolParameters: 'Parameters', noTools: 'No tools are available.', status: 'Status',
    updatesTitle: 'Updates', updatesDescription: 'Mobius checks GitHub Releases at startup and every six hours. Downloads are verified before installation.', currentVersion: 'Current version', latestVersion: 'Latest version', checkForUpdates: 'Check for updates', checkingForUpdates: 'Checking for updates…', updateChecking: 'Checking', updateCurrent: 'Up to date', updateReady: 'Ready to install', updateFailed: 'Check failed', restartToInstall: 'Restart and install', restartingToInstall: 'Restarting to install…',
    skillsTitle: 'Skills', skillsDescription: 'Installed skills are watched and applied to the next agent API request.', skillsDirectory: 'Skills directory', installedSkills: 'Installed skills', noSkills: 'No SKILL.md files found.', skillDirectory: 'Installation directory',
    controller: 'Controller', executor: 'Tool executor', deploymentRole: 'Deployment role', controllerDescription: 'Runs the main thread, model inference, and local or remote tools.', executorDescription: 'Exposes local tools through device tokens and does not require a model upstream.', checkpoint: 'Checkpoint', fullHistory: 'full-history messages', memoryFacts: 'durable facts', activeInputs: 'active inputs', backgroundWork: 'background tasks', announceReplies: 'Automatic voice announcements', continuousVoice: 'Continuous voice', speakResult: 'Speak', preparingVoice: 'Preparing voice…', showParameters: 'Show parameters', hideParameters: 'Hide parameters', mainThreadQueued: 'Queued in the main thread', mainThreadRunning: 'Compiling context', checkpointing: 'Creating checkpoint', retrying: 'Retrying automatically', retryNow: 'Retry now', executorOnly: 'This machine is a tool executor. Use a controller Mobius to call its tools.', deviceAccess: 'Device access', deviceAccessDescription: 'Create a scoped token for another Mobius controller. The secret is shown once.', createDeviceToken: 'Create device token', tokenLabel: 'Token label', allowFilesystem: 'Allow filesystem', allowBash: 'Allow Bash', tokenSecret: 'Copy this secret now', revoke: 'Revoke', deviceToken: 'Device token', capabilities: 'Capabilities', verifyMachine: 'Enrollment verifies the shared issuer and root user.', threads: 'Threads', threadsTitle: 'Threads', threadsDescription: 'The main thread stays first, followed by live subthreads that have not been reaped.', noActiveThreads: 'No active subthreads.', thread: 'Thread', threadTask: 'Task', threadModel: 'Model', threadUpdated: 'Updated', threadDetails: 'Thread details', threadDetailsDescription: 'Read-only history and live events from this subthread.', backToThreads: 'Back to threads', events: 'Events', noThreadEvents: 'No events yet.', event: 'Event', time: 'Time', details: 'Details', threadQueued: 'Queued', threadRunning: 'Running', threadRetrying: 'Retrying', threadIdle: 'Idle', mainThread: 'Main thread', mainThreadDescription: 'The single user thread that accepts prompts.', mainThreadModel: 'Main thread model', subthreadModel: 'Subthread model', mainThreadModelHint: 'Used only by the main conversation.', subthreadModelHint: 'Captured when each subthread is forked.',
  },
  zh: {
    machine: '机器', console: '控制台', machines: '机器', files: '文件', commands: '命令', resources: '资源', tools: '工具', skills: '技能', settings: '设置', connecting: '正在连接…', loadingMachine: '正在加载机器', online: '在线', light: '亮色', dark: '深色', language: '语言',
    consoleDescription: '实时展示 Agent 的执行过程。', context: '上下文', tokens: 'tokens', duration: '用时', seconds: '秒', stop: '停止', startRecording: '开始语音输入', stopRecording: '停止语音输入', transcribing: '正在转写…', agentWorking: 'Agent 正在执行…', greeting: '我已连接到这台机器。请告诉我你想要达成的结果。', queued: '排队中', completed: '已完成', calling: '正在调用', listingFiles: '正在列出', listedFiles: '已列出', readingFile: '正在读取', readFile: '已读取', writingFile: '正在编辑', wroteFile: '已编辑', runningCommand: '正在运行命令', ranCommand: '已运行命令', searchingWeb: '正在搜索网页', searchedWeb: '已搜索网页', reasoning: '推理', parameters: '参数', generatingImage: '正在生成图片', generatedImage: '已生成图片', addedLines: '增加', deletedLines: '删除', lines: '行', outcomePlaceholder: '描述你想要的结果…', queuedPlaceholder: '追加一条后续提示词…', composeHint: 'Enter 发送 · Shift+Enter 换行 · 输入法确认候选时不会发送', queuedCount: '条排队中',
    machinesTitle: '机器', machinesDescription: '将 Mobius 服务器接入当前操作台。', enrolledMachines: '已接入机器', noMachines: '尚未接入远程机器。', addMachine: '添加机器', name: '名称', mobiusUrl: 'Mobius URL', add: '添加机器', remove: '移除', browser: '浏览器', browserTitle: '浏览器控制', browserDescription: 'Agent 会自主创建并控制一次性的隔离 Chromium 会话。', browserCreateHint: 'Agent 会在需要时创建可访问任意网页的会话；仅在你要手动接管时在此创建。', createBrowser: '创建浏览器会话', computerUse: '启用 Computer Use', computerUseHint: '视觉操作在点击或输入前会暂停并请求明确批准。', noBrowserSessions: '当前没有浏览器会话。', selectBrowser: '选择浏览器会话', noBrowser: '不使用浏览器', closeBrowser: '关闭会话', approveAction: '批准操作', browserInput: '向浏览器输入', sendBrowserInput: '发送输入', browserLiveView: '浏览器实时视图', browserClickHint: '点击预览即可直接接管指针输入；可在预览上使用鼠标或触控板滚动。',
    filesTitle: '文件', filesDescription: '浏览并编辑当前机器。', refresh: '刷新', directory: '目录', selectFile: '选择文件', save: '保存',
    commandsTitle: '命令', commandsDescription: '每次 run_bash 调用都会持久化记录；正在运行的命令固定排在前面。', noCommands: '尚未运行任何命令。', command: '命令', commandTarget: '目标机器', commandStartedAt: '开始时间', commandFinishedAt: '结束时间', commandResult: '返回结果', commandExitCode: '返回码', commandRunning: '运行中', commandCancelled: '已取消', commandComplete: '已完成',
    resourcesTitle: '系统资源', resourcesDescription: '实时容量和本地数据库占用。', sampled: '采样时间', cpu: 'CPU', memory: '内存', network: '网络', disk: '磁盘', sqlite: 'SQLite 数据库', load1m: '1 分钟负载', logicalCpus: '逻辑核心', processMemory: 'Mobius RSS', otherMemory: '其他系统占用', available: '可用', swap: '交换分区', received: '接收', transmitted: '发送', interfaces: '网卡', mount: '挂载点', main: '主文件', wal: 'WAL', shm: 'SHM', reclaimable: '可回收', unavailable: '不可用',
    settingsTitle: '设置', settingsDescription: '配置当前机器的 Agent 上游、线程模型和结果朗读。', defaultModel: '默认模型', defaultModelDescription: '用于下一轮 Agent 对话。', modelId: '模型 ID', modelHint: '请输入当前上游支持的模型。', voiceScriptModel: '朗读模型', voiceScriptModelHint: '播放前将最终回复改写为自然口语。', voiceScriptLength: '朗读字数', voiceScriptLengthHint: '生成语音稿的最大字数；150 字通常约为 30 秒。', chineseVoice: '中文 Edge 音色', englishVoice: '英文 Edge 音色', edgeVoiceHint: '使用 Edge Neural 音色名称，例如 {voice}。', baseUrlDescription: '用于下一轮 Agent 对话。', apiKeyDescription: '用于下一轮 Agent 对话。', saveChanges: '保存更改', requestFailed: '请求失败', initializeMobius: '初始化 Mobius', initializeDescription: '将此机器绑定到你的 Auth Mini 身份和 OpenAI 兼容上游。', authMiniUrl: 'Auth Mini 地址', continueAuth: '使用 Auth Mini 继续', apiKey: 'OpenAI API 密钥', baseUrl: '基础地址', initialize: '初始化', returnMachine: '返回机器', signInDescription: '通过已配置的 Auth Mini 服务登录。', toolsTitle: '工具', toolsDescription: '与主线程 Responses 请求一同发送的全部工具。', toolName: '工具', toolDescription: '说明', toolParameters: '参数格式', noTools: '暂时没有可用工具。', status: '状态',
    updatesTitle: '版本更新', updatesDescription: 'Mobius 会在启动时及每六小时检查 GitHub Release。安装前会校验下载内容。', currentVersion: '当前版本', latestVersion: '最新版本', checkForUpdates: '检查更新', checkingForUpdates: '正在检查更新…', updateChecking: '检查中', updateCurrent: '已是最新', updateReady: '可以安装', updateFailed: '检查失败', restartToInstall: '重启并安装', restartingToInstall: '正在重启安装…',
    skillsTitle: '技能', skillsDescription: '已安装的技能目录会被监听，并在下一次 Agent API 请求时生效。', skillsDirectory: '技能目录', installedSkills: '已安装技能', noSkills: '未找到 SKILL.md 文件。', skillDirectory: '安装目录',
    controller: '控制设备', executor: '工具执行设备', deploymentRole: '部署角色', controllerDescription: '运行主线程和模型推理，并调用本机或远程工具。', executorDescription: '通过设备 Token 暴露本机工具，不需要配置模型上游。', checkpoint: '上下文检查点', fullHistory: '条完整历史', memoryFacts: '条长期事实', activeInputs: '条输入处理中', backgroundWork: '个后台任务', announceReplies: '自动语音播报', continuousVoice: '连续语音', speakResult: '播报', preparingVoice: '正在生成语音稿…', showParameters: '展开参数', hideParameters: '收起参数', mainThreadQueued: '已进入主线程队列', mainThreadRunning: '正在编译上下文', checkpointing: '正在创建检查点', retrying: '正在自动重试', retryNow: '立即重试', executorOnly: '这台机器是工具执行设备。请从控制设备上的 Mobius 调用它的工具。', deviceAccess: '设备访问授权', deviceAccessDescription: '为另一台 Mobius 控制设备创建权限受限的 Token；密钥只显示一次。', createDeviceToken: '创建设备 Token', tokenLabel: 'Token 名称', allowFilesystem: '允许文件系统', allowBash: '允许 Bash', tokenSecret: '请立即复制此密钥', revoke: '撤销', deviceToken: '设备 Token', capabilities: '能力', verifyMachine: '接入时会验证双方使用同一 issuer 和 root user。', threads: '线程', threadsTitle: '线程', threadsDescription: '主线程固定置顶，后面列出尚未回收的实时子线程。', noActiveThreads: '当前没有活动子线程。', thread: '线程', threadTask: '任务', threadModel: '模型', threadUpdated: '更新时间', threadDetails: '线程详情', threadDetailsDescription: '只读查看这个子线程的历史记录与实时事件。', backToThreads: '返回线程列表', events: '事件', noThreadEvents: '暂时没有事件。', event: '事件', time: '时间', details: '详情', threadQueued: '排队中', threadRunning: '运行中', threadRetrying: '正在重试', threadIdle: '空闲', mainThread: '主线程', mainThreadDescription: '唯一可以接收 prompt 的用户主线程。', mainThreadModel: '主线程模型', subthreadModel: '子线程模型', mainThreadModelHint: '仅用于主对话。', subthreadModelHint: '每个子线程在 fork 时固化该模型。',
  },
} as const
type TranslationKey = keyof typeof words.en

const queryClient = new QueryClient()
const UiContext = createContext<{ dark: boolean; toggleTheme: () => void; language: Language; setLanguage: (language: Language) => void; t: (key: TranslationKey) => string } | null>(null)
function UiProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('mobius.language') === 'zh' ? 'zh' : 'en')
  const [dark, setDark] = useState(() => localStorage.getItem('mobius.theme') === 'dark' || (!localStorage.getItem('mobius.theme') && matchMedia('(prefers-color-scheme: dark)').matches))
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; localStorage.setItem('mobius.language', language) }, [language])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('mobius.theme', dark ? 'dark' : 'light') }, [dark])
  return <UiContext.Provider value={{ dark, toggleTheme: () => setDark((value) => !value), language, setLanguage, t: (key) => words[language][key] }}>{children}</UiContext.Provider>
}

function useUi() { const value = useContext(UiContext); if (!value) throw new Error('UI context is missing'); return value }
function useAuthToken() { const { sdk } = useAuthMini(); if (!sdk) throw new Error('Auth Mini session is missing'); return sdk }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong.' }
function bytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}` }

const browserFrameBoundary = new TextEncoder().encode('--mobius-frame\r\n')
const browserFrameHeaderEnd = new Uint8Array([13, 10, 13, 10])
const browserFrameDecoder = new TextDecoder()

function byteIndex(buffer: Uint8Array, needle: Uint8Array) {
  for (let start = 0; start <= buffer.length - needle.length; start++) {
    let matches = true
    for (let offset = 0; offset < needle.length; offset++) if (buffer[start + offset] !== needle[offset]) { matches = false; break }
    if (matches) return start
  }
  return -1
}

function nextBrowserFrame(buffer: Uint8Array): [Uint8Array | undefined, Uint8Array] {
  const boundary = byteIndex(buffer, browserFrameBoundary)
  if (boundary < 0) return [undefined, buffer.slice(Math.max(0, buffer.length - browserFrameBoundary.length))]
  const frame = buffer.slice(boundary)
  const headerEnd = byteIndex(frame, browserFrameHeaderEnd)
  if (headerEnd < 0) return [undefined, frame]
  const length = Number(/(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(browserFrameDecoder.decode(frame.slice(0, headerEnd)))?.[1])
  if (!Number.isSafeInteger(length)) return [undefined, frame.slice(browserFrameBoundary.length)]
  const contentStart = headerEnd + browserFrameHeaderEnd.length
  if (frame.length < contentStart + length + 2) return [undefined, frame]
  return [frame.slice(contentStart, contentStart + length), frame.slice(contentStart + length + 2)]
}

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
  for (;;) { const { done, value } = await reader.read(); if (done) return; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; onEvent(JSON.parse(line.slice(6)) as AgentEvent) } }
}

async function streamSubthreadEvents(sdk: AuthMiniApi, threadId: string, after: number, signal: AbortSignal, onMessage: (message: SubthreadStreamMessage) => void) {
  const response = await authenticatedFetch(sdk, `/api/threads/${threadId}/events?after=${after}`, { signal })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const reader = response.body?.getReader(); if (!reader) throw new Error('The subthread did not start an event stream.')
  const decoder = new TextDecoder(); let buffer = ''
  for (;;) { const { done, value } = await reader.read(); if (done) throw new Error('The subthread event stream ended.'); buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const item = JSON.parse(line.slice(6)) as SubthreadStreamMessage; onMessage(item); if (item.type === 'reaped') return; if (item.type === 'error') throw new Error(item.error) } }
}

function callbackUrl() { return `${location.origin}${location.pathname}#/auth/callback` }
function audience() { return location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.hostname : undefined }

function App() { return window.__MOBIUS_AUTH_URL ? <ConfiguredApp authUrl={window.__MOBIUS_AUTH_URL} /> : <Bootstrap /> }

function AuthProvider({ authUrl, children }: { authUrl: string; children: ReactNode }) {
  return <AuthMiniProvider autoRedirectToLogin authMiniBaseUrl={authUrl} callbackUrl={callbackUrl} audience={audience()}>{children}</AuthMiniProvider>
}

function ConfiguredApp({ authUrl }: { authUrl: string }) { return <AuthProvider authUrl={authUrl}><Workspace /></AuthProvider> }

function Bootstrap() {
  const [authUrl, setAuthUrl] = useState(() => sessionStorage.getItem('mobius.auth_url') ?? 'https://auth.ntnl.io')
  const updateAuthUrl = (nextAuthUrl: string) => { sessionStorage.setItem('mobius.auth_url', nextAuthUrl); setAuthUrl(nextAuthUrl) }
  return <AuthProvider authUrl={authUrl}><BootstrapForm authUrl={authUrl} setAuthUrl={updateAuthUrl} /></AuthProvider>
}

function BootstrapForm({ authUrl, setAuthUrl }: { authUrl: string; setAuthUrl: (authUrl: string) => void }) {
  const { t } = useUi()
  const { error: authError, isAuthenticated, session } = useAuthMini()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://openai.ntnl.io/v1')
  const [role, setRole] = useState<DeploymentRole>('controller')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setup = async (event: FormEvent) => {
    event.preventDefault()
    const accessToken = session?.accessToken
    if (!accessToken) return
    setBusy(true)
    try {
      await bootstrapApi('/api/setup', accessToken, { method: 'POST', body: JSON.stringify({ auth_url: authUrl, openai_api_key: apiKey, openai_base_url: baseUrl, deployment_role: role }) })
      location.reload()
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-lg"><CardHeader><CardTitle>{t('initializeMobius')}</CardTitle><CardDescription>{t('initializeDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={setup}><FieldGroup><Field><FieldLabel>{t('deploymentRole')}</FieldLabel><Select value={role} onValueChange={(value) => setRole(value as DeploymentRole)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t('deploymentRole')}</SelectLabel><SelectItem value="controller">{t('controller')}</SelectItem><SelectItem value="executor">{t('executor')}</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</FieldDescription></Field><Field><FieldLabel htmlFor="auth-url">{t('authMiniUrl')}</FieldLabel><Input id="auth-url" value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} required /></Field>{role === 'controller' && <><Field><FieldLabel htmlFor="api-key">{t('apiKey')}</FieldLabel><Input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></Field><Field><FieldLabel htmlFor="base-url">{t('baseUrl')}</FieldLabel><Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field></>}</FieldGroup>{(error || authError) && <ErrorAlert error={error || authError?.message || ''} />}<Button disabled={busy || !isAuthenticated}>{busy && <Spinner data-icon="inline-start" />}{t('initialize')}</Button></form></CardContent></Card></main>
}

type WorkspaceNavItem = { to: string; label: string; icon: typeof TerminalSquareIcon }

function WorkspaceNav({ nav }: { nav: WorkspaceNavItem[] }) {
  const { setOpenMobile } = useSidebar()
  return <SidebarMenu>{nav.map(({ to, label, icon: Icon }) => <SidebarMenuItem key={to}><SidebarMenuButton asChild tooltip={label}><NavLink to={to} onClick={() => setOpenMobile(false)} className={({ isActive }) => isActive ? 'font-medium' : ''}><Icon /><span>{label}</span></NavLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
}

function WorkspaceRoutes({ executor, token }: { executor: boolean; token: AuthMiniApi }) {
  return <Routes><Route path="/console" element={executor ? <Navigate to="/resources" replace /> : null} /><Route path="/threads" element={executor ? <Navigate to="/resources" replace /> : <ThreadsPage token={token} />} /><Route path="/threads/:id" element={executor ? <Navigate to="/resources" replace /> : <ThreadDetailPage token={token} />} /><Route path="/browser" element={executor ? <Navigate to="/resources" replace /> : <BrowserPage token={token} />} /><Route path="/machines" element={<Machines token={token} />} /><Route path="/files" element={<FilesPage token={token} />} /><Route path="/commands" element={<CommandsPage token={token} />} /><Route path="/resources" element={<ResourcesPage token={token} />} /><Route path="/tools" element={<ToolCatalogPage token={token} />} /><Route path="/skills" element={<SkillsPage token={token} />} /><Route path="/settings" element={<SettingsPage token={token} />} /><Route path="*" element={<Navigate to={executor ? "/resources" : "/console"} replace />} /></Routes>
}

function AppHeader({ role, hostname, language }: { role?: DeploymentRole; hostname?: string; language: Language }) {
  const { t } = useUi()
  return <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger><PanelLeftIcon /></SidebarTrigger><Separator orientation="vertical" className="h-4" /><div className="min-w-0"><p className="truncate font-medium">{hostname ?? t('loadingMachine')}</p></div>{role && <Badge className="ml-auto" variant="outline">{role === 'executor' ? t('executor') : t('controller')}</Badge>}<Badge variant="secondary">{t('online')}</Badge><AuthMiniButton lang={language} size="sm" variant="ghost" /></header>
}

function Workspace() {
  const { sdk } = useAuthMini()
  if (!sdk) return null
  const token = sdk
  const { dark, language, setLanguage, toggleTheme, t } = useUi()
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status', token) })
  const operatorNav = [{ to: '/console', label: t('console'), icon: TerminalSquareIcon }, { to: '/threads', label: t('threads'), icon: GitForkIcon }, { to: '/browser', label: t('browser'), icon: Globe2Icon }]
  const machineNav = [{ to: '/machines', label: t('machines'), icon: NetworkIcon }, { to: '/files', label: t('files'), icon: FileIcon }, { to: '/commands', label: t('commands'), icon: TerminalSquareIcon }, { to: '/resources', label: t('resources'), icon: ActivityIcon }, { to: '/tools', label: t('tools'), icon: WrenchIcon }, { to: '/skills', label: t('skills'), icon: BookOpenIcon }, { to: '/settings', label: t('settings'), icon: Settings2Icon }]
  const nav = status.data?.deployment_role === 'executor' ? machineNav : [...operatorNav, ...machineNav]
  const executor = status.data?.deployment_role === 'executor'
  return <SidebarProvider><Sidebar><SidebarHeader><div className="flex items-center gap-2.5 px-2 py-1 font-heading text-lg font-semibold"><img alt="" aria-hidden="true" className="size-6 shrink-0" src="/mobius-mark.png" />Mobius</div></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupLabel>{t('machine')}</SidebarGroupLabel><SidebarGroupContent><WorkspaceNav nav={nav} /></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter><DropdownMenu><DropdownMenuTrigger asChild><Button className="self-center" variant="ghost" size="icon-sm"><LanguagesIcon /><span className="sr-only">{t('language')}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={language} onValueChange={(value) => setLanguage(value as Language)}><DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem><DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><Button variant="ghost" size="sm" onClick={toggleTheme}><MonitorCogIcon data-icon="inline-start" />{dark ? t('light') : t('dark')}</Button></SidebarFooter></Sidebar><SidebarInset className="h-svh overflow-hidden"><AppHeader role={status.data?.deployment_role} hostname={status.data?.hostname} language={language} />{executor ? <div className="min-h-0 flex-1 overflow-y-auto"><WorkspaceRoutes executor token={token} /></div> : <Console token={token}><WorkspaceRoutes executor={false} token={token} /></Console>}</SidebarInset></SidebarProvider>
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

function retryingRun(runs: ConversationRun[]) {
  return [...runs].reverse().find((entry) => entry.status === 'running' && entry.retry_attempt > 0 && entry.next_retry_at !== null)
}

function runError(runs: ConversationRun[]) {
  const run = retryingRun(runs)
  if (!run) return ''
  for (const event of [...run.events].reverse()) if (event.type === 'error') return event.error
  return ''
}

function formatTimestamp(language: Language, value: string) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}

function threadStatusLabel(t: (key: TranslationKey) => string, status: Subthread['status']) {
  return t(status === 'queued' ? 'threadQueued' : status === 'retrying' ? 'threadRetrying' : 'threadRunning')
}

function mainThreadStatusLabel(t: (key: TranslationKey) => string, status: MainThreadSummary['status']) {
  return t(status === 'running' ? 'threadRunning' : status === 'retrying' ? 'threadRetrying' : 'threadIdle')
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
  return <main className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><Button asChild variant="outline" size="sm"><Link to="/threads"><ArrowLeftIcon data-icon="inline-start" />{t('backToThreads')}</Link></Button><div className="min-w-0"><h1 className="truncate font-heading text-lg font-semibold">{thread.title}</h1><p className="text-sm text-muted-foreground">{t('threadDetailsDescription')}</p></div><Badge className="ml-auto" variant={thread.status === 'running' ? 'secondary' : 'outline'}>{threadStatusLabel(t, thread.status)}</Badge><Badge variant="outline">{thread.model}</Badge>{contextTokens?.type === 'context' && <Badge variant="outline">{t('context')}: {contextTokens.input_tokens.toLocaleString()} {t('tokens')}</Badge>}</div>{streamError && <div className="px-4 pt-4"><ErrorAlert error={streamError} /></div>}<ConversationFeed items={conversation} running={thread.status === 'running'} />{eventError?.type === 'error' && <div className="px-4 pb-4"><ErrorAlert error={eventError.error} /></div>}</main>
}

function ConversationFeed({ items, running = false }: { items: ConversationItem[]; running?: boolean }) {
  const token = useAuthToken()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) })
  const [now, setNow] = useState(() => Date.now())
  const hasRunningTool = items.some((item) => item.kind === 'tool' && !item.complete && item.started_at)
  useEffect(() => {
    if (!hasRunningTool) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [hasRunningTool])
  return <MessageScrollerProvider autoScroll={false} defaultScrollPosition="end"><MessageScroller className="flex-1"><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl p-4">{items.map((item) => <MessageScrollerItem key={item.kind === 'tool' ? item.call_id : item.id} className="[content-visibility:visible] [contain-intrinsic-size:auto]"><ConversationEntry item={item} now={now} peers={peers.data ?? []} /></MessageScrollerItem>)}{running && <MessageScrollerItem className="[content-visibility:visible] [contain-intrinsic-size:auto]"><ThreadRunning /></MessageScrollerItem>}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" /></MessageScroller></MessageScrollerProvider>
}

function ThreadRunning() {
  const { t } = useUi()
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /><Badge variant="secondary">{t('threadRunning')}</Badge><span>{t('agentWorking')}</span></div>
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
  const activeSubthreads = threadsQuery.data?.subthreads ?? []

  useEffect(() => {
    if (!conversationQuery.data || activeRef.current.size > 0) return
    const latestAssistant = [...conversationQuery.data.messages].reverse().find((entry) => entry.role === 'assistant' && entry.id !== undefined)
    if (conversationInitialized && latestAssistant?.id !== announcedMessageRef.current) announce(latestAssistant?.content ?? null)
    announcedMessageRef.current = latestAssistant?.id ?? null
    updateConversation(conversationItems(conversationQuery.data))
    setContextTokens(latestContextTokens(conversationQuery.data.runs))
    setActiveRuns(conversationQuery.data.runs.filter((run) => run.status === 'running' && run.next_retry_at === null).map((run) => run.id))
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

  const retryNow = async (runId: string) => {
    try {
      setError('')
      await api(`/api/agent/turn/${runId}`, token, { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['conversation'] })
    } catch (cause) {
      setError(message(cause))
    }
  }

  const unavailable = conversationQuery.isLoading || Boolean(conversationQuery.error)
  const checkpoint = conversationQuery.data?.context.checkpoint
  const historyMessages = conversationQuery.data?.context.history_messages ?? 0
  const memoryFacts = conversationQuery.data?.context.memory.facts ?? 0
  const persistedError = conversationQuery.data ? runError(conversationQuery.data.runs) : ''
  const retryingMainRun = conversationQuery.data ? retryingRun(conversationQuery.data.runs) : undefined
  const mainThreadRunning = activeRuns.length > 0 || conversationQuery.data?.runs.some((run) => run.status === 'running' && run.next_retry_at === null) === true
  const consoleSurface = <main className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><div><h1 className="font-heading text-lg font-semibold">{t('console')}</h1><p className="text-sm text-muted-foreground">{t('consoleDescription')}</p></div><Badge className="ml-auto" variant="outline">{t('context')}: {contextTokens?.toLocaleString() ?? '—'} {t('tokens')}</Badge>{checkpoint && <Badge variant="outline">{t('checkpoint')} #{checkpoint.id}</Badge>}<Badge variant="outline">{historyMessages} {t('fullHistory')}</Badge><Badge variant="outline">{memoryFacts} {t('memoryFacts')}</Badge>{activeRuns.length > 0 && <Badge variant="secondary">{activeRuns.length} {t('activeInputs')}</Badge>}{activeSubthreads.length > 0 && <Badge variant="secondary">{activeSubthreads.length} {t('backgroundWork')}</Badge>}{activeRuns.length > 0 && <Button variant="destructive" size="sm" onClick={() => void stopAll()}><CircleStopIcon data-icon="inline-start" />{t('stop')}</Button>}</div><div className="flex flex-wrap items-center gap-4 border-b px-4 py-2"><Field className="w-auto" orientation="horizontal"><Switch id="continuous-voice" checked={continuousVoice} onCheckedChange={setContinuous} /><FieldLabel htmlFor="continuous-voice">{t('continuousVoice')}</FieldLabel></Field><Field className="w-auto" orientation="horizontal"><Switch id="announce-replies" checked={announceReplies} onCheckedChange={setAnnounce} /><FieldLabel htmlFor="announce-replies">{t('announceReplies')}</FieldLabel></Field>{activeSubthreads.map((thread) => <div key={thread.id} className="flex items-center gap-2"><Badge variant="outline">{thread.title}</Badge><Button aria-label={`${t('stop')}: ${thread.title}`} size="icon-sm" variant="ghost" onClick={async () => { await api(`/api/threads/${thread.id}`, token, { method: 'DELETE' }); await threadsQuery.refetch() }}><XIcon /></Button></div>)}</div>{conversationInitialized ? <ConversationFeed items={conversation} running={mainThreadRunning} /> : <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div>}{conversationQuery.error && <div className="px-4 pb-2"><ErrorAlert error={message(conversationQuery.error)} /></div>}{persistedError && <div className="px-4 pb-2"><Alert variant="destructive"><AlertTitle>{t('retrying')}</AlertTitle><AlertDescription className="flex flex-wrap items-center gap-3"><span>{persistedError}</span>{retryingMainRun && <Button size="sm" variant="outline" onClick={() => void retryNow(retryingMainRun.id)}><RefreshCwIcon data-icon="inline-start" />{t('retryNow')}</Button>}</AlertDescription></Alert></div>}</main>
  return <><div className="min-h-0 flex-1 overflow-y-auto">{location.pathname === '/console' ? consoleSurface : children}</div>{error && <div className="shrink-0 px-4 pt-2"><ErrorAlert error={error} /></div>}<form className="shrink-0 border-t p-3" onSubmit={submit}><InputGroup className="mx-auto max-w-4xl"><InputGroupTextarea ref={draftRef} disabled={unavailable} onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }} onKeyDown={(event) => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return; event.preventDefault(); event.currentTarget.form?.requestSubmit() }} placeholder={activeRuns.length ? t('queuedPlaceholder') : t('outcomePlaceholder')} rows={2} /><InputGroupAddon align="inline-end"><InputGroupButton aria-label={recording ? t('stopRecording') : t('startRecording')} disabled={unavailable || transcribing} onClick={toggleRecording} size="icon-sm" variant={recording ? 'destructive' : 'ghost'}>{recording ? <SquareIcon /> : <MicIcon />}</InputGroupButton><InputGroupButton disabled={unavailable} type="submit" variant="default" size="icon-sm"><SendIcon /><span className="sr-only">{t('mainThread')}</span></InputGroupButton></InputGroupAddon></InputGroup><p className="mx-auto mt-1 max-w-4xl text-xs text-muted-foreground">{t('mainThread')}: {transcribing ? t('transcribing') : t('composeHint')}</p></form></>
}

function BrowserPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const previewRef = useRef<HTMLDivElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const sendInputRef = useRef<(input: Record<string, unknown>) => Promise<void>>(async () => {})
  const sessions = useQuery({ queryKey: ['browser-sessions'], queryFn: () => api<BrowserSession[]>('/api/browser/sessions', token), refetchInterval: 1000 })
  const [selectedId, setSelectedId] = useState('')
  const [browserInput, setBrowserInput] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const selected = sessions.data?.find((session) => session.id === selectedId) ?? sessions.data?.[0]

  useEffect(() => { if (selected && selected.id !== selectedId) setSelectedId(selected.id) }, [selected, selectedId])

  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['browser-sessions'] }) }
  const create = async (event: FormEvent) => {
    event.preventDefault()
    setCreating(true)
    setError('')
    try {
      const session = await api<BrowserSession>('/api/browser/sessions', token, { method: 'POST', body: JSON.stringify({}) })
      setSelectedId(session.id)
      await refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setCreating(false)
    }
  }
  const sendInput = async (input: Record<string, unknown>) => {
    if (!selected) return
    setError('')
    try {
      await api(`/api/browser/sessions/${selected.id}/input`, token, { method: 'POST', body: JSON.stringify(input) })
    } catch (cause) {
      setError(message(cause))
    }
  }
  sendInputRef.current = sendInput
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    let active = true
    let decoding = false
    let latest: Uint8Array<ArrayBufferLike> | undefined
    let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array()
    setPreviewReady(false)
    const drawLatest = async () => {
      if (decoding || !latest) return
      decoding = true
      const frame = latest
      latest = undefined
      try {
        const bytes = new Uint8Array(frame.byteLength)
        bytes.set(frame)
        const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/jpeg' }))
        if (active) {
          const canvas = previewCanvasRef.current
          const context = canvas?.getContext('2d')
          if (canvas && context) {
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
            setPreviewReady(true)
          }
        }
        bitmap.close()
      } finally {
        decoding = false
        if (active && latest) void drawLatest()
      }
    }
    const receive = async () => {
      const response = await authenticatedFetch(token, `/api/browser/sessions/${selected.id}/stream`, { signal: controller.signal })
      if (!response.ok) throw new Error(response.statusText)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Browser preview stream is unavailable.')
      while (active) {
        const { done, value } = await reader.read()
        if (done) return
        const appended = new Uint8Array(buffered.length + value.length)
        appended.set(buffered)
        appended.set(value, buffered.length)
        buffered = appended
        while (active) {
          const [frame, remainder] = nextBrowserFrame(buffered)
          buffered = remainder
          if (!frame) break
          latest = frame
          void drawLatest()
        }
      }
    }
    void receive().catch((cause) => { if (active && !controller.signal.aborted) setError(message(cause)) })
    return () => { active = false; controller.abort() }
  }, [selected?.id, token])
  useEffect(() => {
    const preview = previewRef.current
    if (!preview) return
    let scrollContainer = preview.parentElement
    while (scrollContainer && scrollContainer.scrollHeight <= scrollContainer.clientHeight) scrollContainer = scrollContainer.parentElement
    let pendingDelta = 0
    let sending = false
    let scheduled = false
    const flushScroll = () => {
      scheduled = false
      if (sending || pendingDelta === 0) return
      const deltaY = pendingDelta
      pendingDelta = 0
      sending = true
      void sendInputRef.current({ type: 'scroll', delta_y: deltaY }).finally(() => {
        sending = false
        if (pendingDelta !== 0 && !scheduled) { scheduled = true; requestAnimationFrame(flushScroll) }
      })
    }
    const onWheel = (event: WheelEvent) => {
      const scrollTop = scrollContainer?.scrollTop
      event.preventDefault()
      event.stopPropagation()
      requestAnimationFrame(() => { if (scrollContainer && scrollTop !== undefined) scrollContainer.scrollTop = scrollTop })
      pendingDelta += event.deltaY
      if (!scheduled) { scheduled = true; requestAnimationFrame(flushScroll) }
    }
    preview.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => preview.removeEventListener('wheel', onWheel, true)
  }, [selected?.id])
  const typeInput = async (event: FormEvent) => {
    event.preventDefault()
    if (!browserInput.trim()) return
    await sendInput({ type: 'type', text: browserInput })
    setBrowserInput('')
  }
  const close = async () => {
    if (!selected) return
    try {
      await api(`/api/browser/sessions/${selected.id}`, token, { method: 'DELETE' })
      setSelectedId('')
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }
  const approve = async () => {
    if (!selected) return
    try {
      await api(`/api/browser/sessions/${selected.id}/approve`, token, { method: 'POST' })
      await refresh()
    } catch (cause) {
      setError(message(cause))
    }
  }

  if (sessions.error) return <Page title={t('browserTitle')} description={t('browserDescription')}><ErrorAlert error={message(sessions.error)} /></Page>
  return <Page title={t('browserTitle')} description={t('browserDescription')}><Card><CardHeader><CardTitle>{t('createBrowser')}</CardTitle><CardDescription>{t('browserCreateHint')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={create}>{error && <ErrorAlert error={error} />}<Button className="w-fit" disabled={creating}>{creating && <Spinner data-icon="inline-start" />}{t('createBrowser')}</Button></form></CardContent></Card>{sessions.data && sessions.data.length > 0 ? <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]"><Card><CardHeader><CardTitle>{t('selectBrowser')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2">{sessions.data.map((session) => <Button key={session.id} variant={selected?.id === session.id ? 'secondary' : 'outline'} className="h-auto justify-start whitespace-normal text-left" onClick={() => setSelectedId(session.id)}><span><strong>{session.url}</strong><br /><span className="text-xs text-muted-foreground">{session.id.slice(0, 8)} · Browser Control</span></span></Button>)}</CardContent></Card><Card><CardHeader><div className="flex flex-wrap items-center gap-2"><div className="flex-1"><CardTitle>{t('browserLiveView')}</CardTitle><CardDescription>{selected?.url}</CardDescription></div>{selected?.pending_approval && <Button onClick={() => void approve()}>{t('approveAction')}</Button>}<Button variant="outline" onClick={() => void close()}>{t('closeBrowser')}</Button></div>{selected?.pending_approval && <Alert><AlertTitle>{t('approveAction')}</AlertTitle><AlertDescription>{selected.pending_approval.description}</AlertDescription></Alert>}</CardHeader><CardContent className="flex flex-col gap-4"><div ref={previewRef} className="relative overflow-hidden rounded-md border bg-muted"><canvas ref={previewCanvasRef} aria-label={t('browserLiveView')} className="block aspect-[8/5] w-full cursor-crosshair" height={800} width={1280} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); void sendInput({ type: 'click', x: (event.clientX - bounds.left) * 1280 / bounds.width, y: (event.clientY - bounds.top) * 800 / bounds.height }) }} />{!previewReady && <div className="absolute inset-0 grid place-items-center"><Spinner /></div>}</div><p className="text-xs text-muted-foreground">{t('browserClickHint')}</p><form className="flex gap-2" onSubmit={(event) => void typeInput(event)}><Input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} placeholder={t('browserInput')} /><Button type="submit">{t('sendBrowserInput')}</Button></form></CardContent></Card></div> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('noBrowserSessions')}</CardContent></Card>}</Page>
}

function ConversationEntry({ item, now, peers }: { item: ConversationItem; now: number; peers: Peer[] }) {
  const { language, t } = useUi()
  const [parametersOpen, setParametersOpen] = useState(false)
  if (item.kind === 'status') {
    const label = item.stage === 'queued' ? t('mainThreadQueued') : item.stage === 'checkpointing' ? t('checkpointing') : item.stage === 'retrying' ? t('retrying') : t('mainThreadRunning')
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
    const parameters = item.name === 'reasoning' ? '' : Object.keys(item.arguments).length ? JSON.stringify(targetDeviceLabel ? { ...item.arguments, target_device: targetDeviceLabel } : item.arguments, null, 2) : ''
    const changes = item.complete && (item.name === 'write_file' || item.name === 'edit_file') && item.added_lines !== undefined && item.deleted_lines !== undefined ? ` · ${t('addedLines')} ${item.added_lines ?? 0} ${t('lines')} · ${t('deletedLines')} ${item.deleted_lines ?? 0} ${t('lines')}` : ''
    const started = item.started_at ? Date.parse(item.started_at) : NaN
    const finished = item.finished_at ? Date.parse(item.finished_at) : now
    const elapsed = Number.isNaN(started) ? null : Math.max(0, Math.floor((finished - started) / 1000))
    const duration = elapsed === null ? '' : ` · ${t('duration')}: ${elapsed} ${t('seconds')}`
    return <div className="flex items-start gap-2 text-sm text-muted-foreground">{item.complete ? item.name === 'run_bash' ? <TerminalSquareIcon className="mt-0.5 size-5 shrink-0 text-foreground" /> : <CheckIcon className={`mt-0.5 text-foreground ${item.name === 'web_search' ? 'size-5 shrink-0' : 'size-4'}`} /> : <Spinner className="mt-0.5" />}<div className="min-w-0 break-all">{summary ? <><span>{action ?? item.name}{duration}</span><div className="prose prose-sm mt-1 max-w-none text-foreground dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown></div></> : <><span>{action ?? item.name} <code className="font-mono text-foreground">{target}</code>{targetDeviceLabel && <> · {targetDeviceLabel}</>}{changes}{duration}</span>{parameters && <div className="mt-1 text-xs"><Button aria-expanded={parametersOpen} size="sm" variant="ghost" onClick={() => setParametersOpen((open) => !open)}>{parametersOpen ? t('hideParameters') : t('showParameters')}</Button>{parametersOpen && <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-foreground"><code>{parameters}</code></pre>}</div>}</>}</div></div>
  }
  if (item.message.role !== 'assistant') return <Message align="end"><MessageContent><Card size="sm"><CardContent className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></CardContent></Card></MessageContent></Message>
  const timestamp = item.message.created_at ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.message.created_at)) : null
  const duration = item.message.duration_ms === undefined ? null : `${t('duration')}: ${(item.message.duration_ms / 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })} ${t('seconds')}`
  const tokens = item.message.input_tokens === undefined || item.message.output_tokens === undefined ? null : `${(item.message.input_tokens + item.message.output_tokens).toLocaleString()} ${t('tokens')}`
  return <Message><MessageContent className="gap-1.5"><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></div>{item.message.images?.map((image) => <Card key={image.id} size="sm"><CardContent className="p-0"><img alt={t('generatedImage')} className="max-w-full" src={`data:image/png;base64,${image.data}`} /></CardContent></Card>)}<MessageFooter className="gap-2 px-0 font-normal">{[timestamp, duration, tokens].filter(Boolean).map((detail) => <span key={detail}>{detail}</span>)}{item.message.content && <ManualAnnouncementButton content={item.message.content} />}</MessageFooter></MessageContent></Message>
}

function ManualAnnouncementButton({ content }: { content: string }) {
  const token = useAuthToken()
  const { language, t } = useUi()
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const announce = async () => {
    setPreparing(true)
    setError('')
    try {
      const { text } = await createVoiceScript(token, content)
      try {
        const audio = new Audio(URL.createObjectURL(await createSpeech(token, text, language)))
        await new Promise<void>((resolve, reject) => {
          const finish = () => URL.revokeObjectURL(audio.src)
          audio.addEventListener('ended', () => { finish(); resolve() }, { once: true })
          audio.addEventListener('error', () => { finish(); reject(new Error('Edge TTS audio could not be played.')) }, { once: true })
          void audio.play().catch(reject)
        })
      } catch {
        if (!('speechSynthesis' in window)) throw new Error('Speech playback is unavailable.')
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.lang = language === 'zh' ? 'zh-CN' : 'en-US'
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(utterance)
      }
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPreparing(false)
    }
  }
  return <span className="flex items-center gap-1"><Button disabled={preparing} size="sm" variant="ghost" onClick={() => void announce()}>{preparing ? <Spinner data-icon="inline-start" /> : <Volume2Icon data-icon="inline-start" />}{preparing ? t('preparingVoice') : t('speakResult')}</Button>{error && <span className="text-destructive">{error}</span>}</span>
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

function CommandsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const commands = useQuery({ queryKey: ['commands'], queryFn: () => api<CommandRun[]>('/api/commands', token), refetchInterval: 1000 })
  const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—'
  const status = (run: CommandRun) => run.status === 'running' ? { label: t('commandRunning'), variant: 'secondary' as const } : run.status === 'cancelled' ? { label: t('commandCancelled'), variant: 'outline' as const } : { label: t('commandComplete'), variant: 'default' as const }
  if (commands.error) return <Page title={t('commandsTitle')} description={t('commandsDescription')}><ErrorAlert error={message(commands.error)} /></Page>
  if (!commands.data) return <Page title={t('commandsTitle')} description={t('commandsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('commandsTitle')} description={t('commandsDescription')}><Card><CardHeader><CardTitle>{t('commandsTitle')}</CardTitle><CardDescription>{t('commandsDescription')}</CardDescription></CardHeader><CardContent>{commands.data.length === 0 ? <p className="text-sm text-muted-foreground">{t('noCommands')}</p> : <Table><TableHeader><TableRow><TableHead>{t('command')}</TableHead><TableHead>{t('commandTarget')}</TableHead><TableHead>{t('status')}</TableHead><TableHead>{t('commandStartedAt')}</TableHead><TableHead>{t('commandFinishedAt')}</TableHead><TableHead>{t('commandExitCode')}</TableHead><TableHead>{t('commandResult')}</TableHead></TableRow></TableHeader><TableBody>{commands.data.map((run) => { const runStatus = status(run); return <TableRow key={run.id}><TableCell className="max-w-80 whitespace-normal align-top"><code className="block break-all whitespace-pre-wrap font-mono text-xs">{run.command}</code></TableCell><TableCell className="max-w-52 whitespace-normal align-top"><p>{run.target_machine_name}</p><code className="block break-all text-xs text-muted-foreground">{run.target_machine_id}</code></TableCell><TableCell className="align-top"><Badge variant={runStatus.variant}>{runStatus.label}</Badge></TableCell><TableCell className="align-top text-xs text-muted-foreground">{formatTime(run.started_at)}</TableCell><TableCell className="align-top text-xs text-muted-foreground">{formatTime(run.completed_at)}</TableCell><TableCell className="align-top font-mono">{run.exit_code ?? '—'}</TableCell><TableCell className="max-w-96 whitespace-normal align-top"><pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all"><code>{run.result ?? '—'}</code></pre></TableCell></TableRow> })}</TableBody></Table>}</CardContent></Card></Page>
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

function ToolCatalogPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const query = useQuery({ queryKey: ['tools'], queryFn: () => api<ToolCatalog>('/api/tools', token) })
  if (query.error) return <Page title={t('toolsTitle')} description={t('toolsDescription')}><ErrorAlert error={message(query.error)} /></Page>
  if (!query.data) return <Page title={t('toolsTitle')} description={t('toolsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('toolsTitle')} description={t('toolsDescription')}><div className="flex flex-col gap-4">{query.data.tools.map((tool) => <Card key={tool.name ?? tool.type}><CardContent className="grid gap-4 py-5 lg:grid-cols-[minmax(12rem,0.65fr)_minmax(16rem,1fr)_minmax(24rem,1.6fr)]"><div><p className="text-xs text-muted-foreground">{t('toolName')}</p><code className="font-medium">{tool.name ?? tool.type}</code></div><div><p className="text-xs text-muted-foreground">{t('toolDescription')}</p><p className="mt-1 text-sm">{tool.description ?? tool.type}</p></div><div><p className="text-xs text-muted-foreground">{t('toolParameters')}</p>{tool.parameters ? <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground"><code>{JSON.stringify(tool.parameters, null, 2)}</code></pre> : <p className="mt-1 text-sm text-muted-foreground">—</p>}</div></CardContent></Card>)}</div>{query.data.tools.length === 0 && <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('noTools')}</CardContent></Card>}</Page>
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
  const [voiceScriptMaxChars, setVoiceScriptMaxChars] = useState(150)
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
    setVoiceScriptMaxChars(settings.data?.voice_script_max_chars ?? 150)
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
        body: JSON.stringify({ default_model: model, subthread_model: subthreadModel, voice_script_model: voiceScriptModel, voice_script_max_chars: voiceScriptMaxChars, edge_tts_zh_voice: zhVoice, edge_tts_en_voice: enVoice, openai_base_url: baseUrl, openai_api_key: apiKey, deployment_role: role }),
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

  return <Page title={t('settingsTitle')} description={t('settingsDescription')}><Card><CardHeader><CardTitle>{t('settingsTitle')}</CardTitle><CardDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={save}><FieldGroup><Field><FieldLabel>{t('deploymentRole')}</FieldLabel><Select value={role} onValueChange={(value) => setRole(value as DeploymentRole)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t('deploymentRole')}</SelectLabel><SelectItem value="controller">{t('controller')}</SelectItem><SelectItem value="executor">{t('executor')}</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>{role === 'controller' ? t('controllerDescription') : t('executorDescription')}</FieldDescription></Field>{role === 'controller' && <><Field><FieldLabel htmlFor="model">{t('mainThreadModel')}</FieldLabel><Input id="model" value={model} onChange={(event) => setModel(event.target.value)} required /><FieldDescription>{t('mainThreadModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="subthread-model">{t('subthreadModel')}</FieldLabel><Input id="subthread-model" value={subthreadModel} onChange={(event) => setSubthreadModel(event.target.value)} required /><FieldDescription>{t('subthreadModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="voice-script-model">{t('voiceScriptModel')}</FieldLabel><Input id="voice-script-model" value={voiceScriptModel} onChange={(event) => setVoiceScriptModel(event.target.value)} required /><FieldDescription>{t('voiceScriptModelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="voice-script-max-chars">{t('voiceScriptLength')}</FieldLabel><Input id="voice-script-max-chars" type="number" min={1} step={1} value={voiceScriptMaxChars} onChange={(event) => setVoiceScriptMaxChars(Number(event.target.value))} required /><FieldDescription>{t('voiceScriptLengthHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="edge-tts-zh-voice">{t('chineseVoice')}</FieldLabel><Input id="edge-tts-zh-voice" value={zhVoice} onChange={(event) => setZhVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'zh-CN-XiaoxiaoNeural')}</FieldDescription></Field><Field><FieldLabel htmlFor="edge-tts-en-voice">{t('englishVoice')}</FieldLabel><Input id="edge-tts-en-voice" value={enVoice} onChange={(event) => setEnVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'en-US-JennyNeural')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-base-url">{t('baseUrl')}</FieldLabel><Input id="openai-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><FieldDescription>{t('baseUrlDescription')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-api-key">{t('apiKey')}</FieldLabel><Input id="openai-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /><FieldDescription>{t('apiKeyDescription')}</FieldDescription></Field></>}</FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{t('saveChanges')}</Button></form></CardContent></Card><UpdatesCard token={token} /></Page>
}
function Page({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6"><div><h1 className="font-heading text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>{children}</main> }
function ErrorAlert({ error }: { error: string }) { const { t } = useUi(); return <Alert variant="destructive"><AlertTitle>{t('requestFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><TooltipProvider><UiProvider><HashRouter><App /></HashRouter></UiProvider></TooltipProvider></QueryClientProvider>)
