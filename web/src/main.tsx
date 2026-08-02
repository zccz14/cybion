import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { createBrowserSdk } from 'auth-mini/sdk/browser'
import type { AuthMiniApi, SessionSnapshot } from 'auth-mini/sdk/browser'
import { ActivityIcon, BookOpenIcon, CheckIcon, CircleStopIcon, CpuIcon, DatabaseIcon, FileIcon, FolderIcon, HardDriveIcon, KeyRoundIcon, LanguagesIcon, MemoryStickIcon, MicIcon, MonitorCogIcon, NetworkIcon, PanelLeftIcon, PlusIcon, RefreshCwIcon, SendIcon, ServerIcon, Settings2Icon, SquareIcon, TerminalSquareIcon, WrenchIcon, XIcon } from 'lucide-react'
import { createContext, FormEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { HashRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles.css'

declare global { interface Window { __MOBIUS_AUTH_URL: string | null } }

type Status = { machine_id: string; hostname: string; root_user_id: string; auth_url: string; openai_base_url: string }
type Settings = { default_model: string; openai_base_url: string; openai_api_key: string }
type Peer = { id: string; name: string; base_url: string; created_at: string }
type FileEntry = { name: string; path: string; kind: 'file' | 'directory'; size: number }
type SystemResources = { sampled_at: number; sample_interval_ms: number; cpu: { usage_percent: number; load_1m: number; logical_cpus: number }; memory: { used_bytes: number; total_bytes: number; available_bytes: number; process_used_bytes: number; other_used_bytes: number; usage_percent: number; swap_used_bytes: number; swap_total_bytes: number }; network: { receive_bytes_per_second: number; transmit_bytes_per_second: number; interfaces: number }; disk: { mount_point: string; used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number } | null; sqlite: { main_bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number; freelist_bytes: number; freelist_percent: number } }
type GeneratedImage = { id: string; data: string }
type ChatMessage = { role: string; content: string | null; images?: GeneratedImage[]; created_at?: string; duration_ms?: number; input_tokens?: number; output_tokens?: number }
type Transcription = { text: string }
type Skill = { name: string; description: string; directory: string }
type Skills = { directory: string; skills: Skill[] }
type AgentEvent = { type: 'tool_call'; call_id: string; name: string; arguments: Record<string, unknown> } | { type: 'tool_result'; call_id: string; name: string; added_lines: number | null; deleted_lines: number | null } | { type: 'context'; input_tokens: number } | { type: 'complete'; message: ChatMessage } | { type: 'error'; error: string }
type ConversationItem = { kind: 'message'; id: string; message: ChatMessage; queued: boolean } | { kind: 'tool'; call_id: string; name: string; arguments: Record<string, unknown>; complete: boolean; added_lines?: number | null; deleted_lines?: number | null }
type Session = SessionSnapshot
type Language = 'en' | 'zh'
type ToolsetPreview = { id: 'filesystem' | 'bash' | 'web_search' | 'image_generation'; name: string; description: string; tools: string[]; enabled: boolean }
type Toolsets = { filesystem_enabled: boolean; bash_enabled: boolean; web_search_enabled: boolean; image_generation_enabled: boolean }

const words = {
  en: {
    machine: 'Machine', console: 'Console', machines: 'Machines', files: 'Files', resources: 'Resources', tools: 'Tools', skills: 'Skills', settings: 'Settings', connecting: 'Connecting…', loadingMachine: 'Loading machine', online: 'Online', light: 'Light', dark: 'Dark', signOut: 'Sign out', language: 'Language',
    consoleDescription: 'Agent activity is streamed as it happens.', context: 'Context', tokens: 'tokens', duration: 'Duration', seconds: 's', stop: 'Stop', startRecording: 'Start voice input', stopRecording: 'Stop voice input', transcribing: 'Transcribing…', agentWorking: 'Agent is working…', greeting: 'I am connected to this machine. Tell me the outcome you want to reach.', queued: 'Queued', completed: 'Completed', calling: 'Calling', listingFiles: 'Listing', listedFiles: 'Listed', readingFile: 'Reading', readFile: 'Read', writingFile: 'Editing', wroteFile: 'Edited', runningCommand: 'Running command', ranCommand: 'Ran command', searchingWeb: 'Searching the web', searchedWeb: 'Searched the web', generatingImage: 'Generating image', generatedImage: 'Generated image', addedLines: 'added', deletedLines: 'deleted', lines: 'lines', outcomePlaceholder: 'Describe the outcome you want…', queuedPlaceholder: 'Add a follow-up prompt to the queue…', composeHint: 'Enter to send · Shift+Enter for a new line', queuedCount: 'queued',
    machinesTitle: 'Machines', machinesDescription: 'Connect Mobius servers to this operator.', enrolledMachines: 'Enrolled machines', noMachines: 'No remote machines enrolled.', addMachine: 'Add a machine', name: 'Name', mobiusUrl: 'Mobius URL', add: 'Add machine', remove: 'Remove',
    filesTitle: 'Files', filesDescription: 'Browse and edit the active machine.', refresh: 'Refresh', directory: 'Directory', selectFile: 'Select a file', save: 'Save',
    resourcesTitle: 'Resources', resourcesDescription: 'Live capacity and local database usage.', sampled: 'Sampled', cpu: 'CPU', memory: 'Memory', network: 'Network', disk: 'Disk', sqlite: 'SQLite database', load1m: '1m load', logicalCpus: 'Logical CPUs', processMemory: 'Mobius RSS', otherMemory: 'Other system usage', available: 'Available', swap: 'Swap', received: 'Received', transmitted: 'Transmitted', interfaces: 'Interfaces', mount: 'Mount', main: 'Main', wal: 'WAL', shm: 'SHM', reclaimable: 'Reclaimable', unavailable: 'Unavailable',
    settingsTitle: 'Settings', settingsDescription: 'Configure this machine\'s agent upstream and default model.', defaultModel: 'Default model', defaultModelDescription: 'Used by the next agent turn.', modelId: 'Model ID', modelHint: 'Use a model supported by the configured upstream.', baseUrlDescription: 'Used for the next agent turn.', apiKeyDescription: 'Used for the next agent turn.', saveChanges: 'Save changes', requestFailed: 'Request failed', initializeMobius: 'Initialize Mobius', initializeDescription: 'Bind this machine to your Auth Mini identity and OpenAI-compatible upstream.', authMiniUrl: 'Auth Mini URL', continueAuth: 'Continue with Auth Mini', apiKey: 'OpenAI API key', baseUrl: 'Base URL', initialize: 'Initialize', returnMachine: 'Return to the machine', signInDescription: 'Sign in through the configured Auth Mini server.', toolsTitle: 'Toolsets', toolsDescription: 'Review and compose the capabilities available to the active agent.', preview: 'Managed', previewTitle: 'Toolset controls', previewDescription: 'Changes apply to new agent turns. Shell commands execute through bash on the active machine.', createToolset: 'Create toolset', toolset: 'Toolset', includedTools: 'Included tools', status: 'Status', scope: 'Scope', enabled: 'Enabled', disabled: 'Disabled', currentAgent: 'Current agent', activeTools: 'active tools', filesystemToolset: 'Filesystem access', filesystemToolsetDescription: 'Read and write files on the active machine.', shellToolset: 'Shell commands', shellToolsetDescription: 'Execute commands through bash on the active machine.', webSearchToolset: 'Web search', webSearchToolsetDescription: 'Search the public web through the configured OpenAI-compatible upstream.', imageGenerationToolset: 'Image generation', imageGenerationToolsetDescription: 'Generate and edit images through the configured OpenAI-compatible upstream.', systemScope: 'System', toolsetDetails: 'Toolset details', toolsetDetailsDescription: 'The selected toolset contributes its tools to the next agent turn.', createToolsetTitle: 'Create a toolset', createToolsetDescription: 'Persistence and agent binding will be added after this interaction model is approved.', toolsetName: 'Toolset name', toolsetDescription: 'Description',
    skillsTitle: 'Skills', skillsDescription: 'Installed skills are watched and applied to the next agent API request.', skillsDirectory: 'Skills directory', installedSkills: 'Installed skills', noSkills: 'No SKILL.md files found.', skillDirectory: 'Installation directory',
  },
  zh: {
    machine: '机器', console: '控制台', machines: '机器', files: '文件', resources: '资源', tools: '工具', skills: '技能', settings: '设置', connecting: '正在连接…', loadingMachine: '正在加载机器', online: '在线', light: '亮色', dark: '深色', signOut: '退出登录', language: '语言',
    consoleDescription: '实时展示 Agent 的执行过程。', context: '上下文', tokens: 'tokens', duration: '用时', seconds: '秒', stop: '停止', startRecording: '开始语音输入', stopRecording: '停止语音输入', transcribing: '正在转写…', agentWorking: 'Agent 正在执行…', greeting: '我已连接到这台机器。请告诉我你想要达成的结果。', queued: '排队中', completed: '已完成', calling: '正在调用', listingFiles: '正在列出', listedFiles: '已列出', readingFile: '正在读取', readFile: '已读取', writingFile: '正在编辑', wroteFile: '已编辑', runningCommand: '正在运行命令', ranCommand: '已运行命令', searchingWeb: '正在搜索网页', searchedWeb: '已搜索网页', generatingImage: '正在生成图片', generatedImage: '已生成图片', addedLines: '增加', deletedLines: '删除', lines: '行', outcomePlaceholder: '描述你想要的结果…', queuedPlaceholder: '追加一条后续提示词…', composeHint: 'Enter 发送 · Shift+Enter 换行', queuedCount: '条排队中',
    machinesTitle: '机器', machinesDescription: '将 Mobius 服务器接入当前操作台。', enrolledMachines: '已接入机器', noMachines: '尚未接入远程机器。', addMachine: '添加机器', name: '名称', mobiusUrl: 'Mobius URL', add: '添加机器', remove: '移除',
    filesTitle: '文件', filesDescription: '浏览并编辑当前机器。', refresh: '刷新', directory: '目录', selectFile: '选择文件', save: '保存',
    resourcesTitle: '系统资源', resourcesDescription: '实时容量和本地数据库占用。', sampled: '采样时间', cpu: 'CPU', memory: '内存', network: '网络', disk: '磁盘', sqlite: 'SQLite 数据库', load1m: '1 分钟负载', logicalCpus: '逻辑核心', processMemory: 'Mobius RSS', otherMemory: '其他系统占用', available: '可用', swap: '交换分区', received: '接收', transmitted: '发送', interfaces: '网卡', mount: '挂载点', main: '主文件', wal: 'WAL', shm: 'SHM', reclaimable: '可回收', unavailable: '不可用',
    settingsTitle: '设置', settingsDescription: '配置当前机器的 Agent 上游和默认模型。', defaultModel: '默认模型', defaultModelDescription: '用于下一轮 Agent 对话。', modelId: '模型 ID', modelHint: '请输入当前上游支持的模型。', baseUrlDescription: '用于下一轮 Agent 对话。', apiKeyDescription: '用于下一轮 Agent 对话。', saveChanges: '保存更改', requestFailed: '请求失败', initializeMobius: '初始化 Mobius', initializeDescription: '将此机器绑定到你的 Auth Mini 身份和 OpenAI 兼容上游。', authMiniUrl: 'Auth Mini 地址', continueAuth: '使用 Auth Mini 继续', apiKey: 'OpenAI API 密钥', baseUrl: '基础地址', initialize: '初始化', returnMachine: '返回机器', signInDescription: '通过已配置的 Auth Mini 服务登录。', toolsTitle: '工具集', toolsDescription: '查看并组合当前 Agent 可使用的能力。', preview: '已管理', previewTitle: '工具集控制', previewDescription: '更改会应用于新的 Agent 对话。Shell 命令会通过当前机器上的 bash 执行。', createToolset: '新建工具集', toolset: '工具集', includedTools: '包含工具', status: '状态', scope: '范围', enabled: '已启用', disabled: '已禁用', currentAgent: '当前 Agent', activeTools: '个已启用工具', filesystemToolset: '文件系统访问', filesystemToolsetDescription: '读取和写入当前机器上的文件。', shellToolset: 'Shell 命令', shellToolsetDescription: '通过当前机器上的 bash 执行命令。', webSearchToolset: '网页搜索', webSearchToolsetDescription: '通过已配置的 OpenAI 兼容上游搜索公开网页。', imageGenerationToolset: '图片生成', imageGenerationToolsetDescription: '通过已配置的 OpenAI 兼容上游生成和编辑图片。', systemScope: '系统', toolsetDetails: '工具集详情', toolsetDetailsDescription: '选中的工具集会在下一轮 Agent 对话中贡献相应工具。', createToolsetTitle: '新建工具集', createToolsetDescription: '在确认这套交互模型后，再接入持久化和 Agent 绑定。', toolsetName: '工具集名称', toolsetDescription: '说明',
    skillsTitle: '技能', skillsDescription: '已安装的技能目录会被监听，并在下一次 Agent API 请求时生效。', skillsDirectory: '技能目录', installedSkills: '已安装技能', noSkills: '未找到 SKILL.md 文件。', skillDirectory: '安装目录',
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
function anonymous(): Session { return { status: 'anonymous', authenticated: false, sessionId: null, accessToken: null, refreshToken: null, receivedAt: null, expiresAt: null } }
function useBrowserSession(sdk: AuthMiniApi | null) { const [session, setSession] = useState<Session>(() => sdk?.session.getState() ?? anonymous()); useEffect(() => { if (!sdk) return; setSession(sdk.session.getState()); return sdk.session.onChange(setSession) }, [sdk]); return session }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong.' }
function bytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}` }

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<T>
}

async function transcribeAudio(token: string, audio: Blob): Promise<Transcription> {
  const form = new FormData()
  form.append('file', audio, `recording.${audio.type.includes('mp4') || audio.type.includes('m4a') ? 'm4a' : 'webm'}`)
  const response = await fetch('/api/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<Transcription>
}

async function streamAgentTurn(token: string, runId: string, message: ChatMessage, signal: AbortSignal, onEvent: (event: AgentEvent) => void) {
  const response = await fetch('/api/agent/turn', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ run_id: runId, message }) })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const reader = response.body?.getReader(); if (!reader) throw new Error('The agent did not start an event stream.')
  const decoder = new TextDecoder(); let buffer = ''
  for (;;) { const { done, value } = await reader.read(); if (done) return; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.startsWith('data: ')) continue; const event = JSON.parse(line.slice(6)) as AgentEvent; onEvent(event); if (event.type === 'error') throw new Error(event.error) } }
}

function normalizedAuthUrl(authUrl: string) { const url = new URL(authUrl.trim()); url.search = ''; url.hash = ''; url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`; return url.toString() }
function beginAuthRedirect(authUrl: string) { const normalized = normalizedAuthUrl(authUrl); const state = crypto.randomUUID(); sessionStorage.setItem('mobius.auth_url', normalized); sessionStorage.setItem('mobius.login_state', state); const callback = `${location.origin}${location.pathname}#/auth/callback`; const params = new URLSearchParams({ redirect_uri: callback, state }); if (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) params.set('aud', location.hostname); location.assign(`${normalized}web/#/login?${params.toString()}`) }
function acceptRedirectSession(): string | null { if (!location.hash.startsWith('#/auth/callback?')) return null; const params = new URLSearchParams(location.hash.slice('#/auth/callback?'.length)); const state = sessionStorage.getItem('mobius.login_state'); const authUrl = sessionStorage.getItem('mobius.auth_url'); if (!authUrl || !state || params.get('state') !== state) return null; const accessToken = params.get('access_token'); const sessionId = params.get('session_id'); const refreshToken = params.get('refresh_token'); const expiresIn = Number(params.get('expires_in')); if (!accessToken || !sessionId || !refreshToken || !Number.isFinite(expiresIn)) return null; const receivedAt = new Date(); localStorage.setItem(`auth-mini.sdk:${normalizedAuthUrl(authUrl)}`, JSON.stringify({ accessToken, sessionId, refreshToken, receivedAt: receivedAt.toISOString(), expiresAt: new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() })); sessionStorage.removeItem('mobius.login_state'); history.replaceState(null, '', `${location.pathname}${location.search}#/console`); return authUrl }

function App() { const authUrl = acceptRedirectSession() ?? window.__MOBIUS_AUTH_URL; const [sdk] = useState<AuthMiniApi | null>(() => authUrl ? createBrowserSdk(authUrl) : null); const session = useBrowserSession(sdk); if (!authUrl) return <Bootstrap session={session} />; if (session.status === 'recovering') return <main className="grid min-h-svh place-items-center"><Spinner /></main>; if (!session.accessToken) return <SignIn />; return <Workspace sdk={sdk} token={session.accessToken} /> }

function Bootstrap({ session }: { session: Session }) { const { t } = useUi(); const [authUrl, setAuthUrl] = useState(() => sessionStorage.getItem('mobius.auth_url') ?? 'https://auth.ntnl.io'); const [apiKey, setApiKey] = useState(''); const [baseUrl, setBaseUrl] = useState('https://openai.ntnl.io/v1'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const signIn = () => { try { beginAuthRedirect(authUrl) } catch (cause) { setError(message(cause)) } }; const setup = async (event: FormEvent) => { event.preventDefault(); if (!session.accessToken) return; setBusy(true); try { await api('/api/setup', session.accessToken, { method: 'POST', body: JSON.stringify({ auth_url: authUrl, openai_api_key: apiKey, openai_base_url: baseUrl }) }); location.reload() } catch (cause) { setError(message(cause)) } finally { setBusy(false) } }; return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-lg"><CardHeader><CardTitle>{t('initializeMobius')}</CardTitle><CardDescription>{t('initializeDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={setup}><FieldGroup><Field><FieldLabel htmlFor="auth-url">{t('authMiniUrl')}</FieldLabel><Input id="auth-url" value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} required /></Field><Button type="button" variant="secondary" onClick={signIn}><KeyRoundIcon data-icon="inline-start" />{t('continueAuth')}</Button><Field><FieldLabel htmlFor="api-key">{t('apiKey')}</FieldLabel><Input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></Field><Field><FieldLabel htmlFor="base-url">{t('baseUrl')}</FieldLabel><Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field></FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={busy || !session.authenticated}>{busy && <Spinner data-icon="inline-start" />}{t('initialize')}</Button></form></CardContent></Card></main> }
function SignIn() { const { t } = useUi(); const [error, setError] = useState(''); return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-sm"><CardHeader><CardTitle>{t('returnMachine')}</CardTitle><CardDescription>{t('signInDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{error && <ErrorAlert error={error} />}<Button onClick={() => { try { beginAuthRedirect(window.__MOBIUS_AUTH_URL!) } catch (cause) { setError(message(cause)) } }}>{t('continueAuth')}</Button></CardContent></Card></main> }

function Workspace({ sdk, token }: { sdk: AuthMiniApi | null; token: string }) {
  const navigate = useNavigate()
  const { dark, language, setLanguage, toggleTheme, t } = useUi()
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status', token) })
  const nav = [{ to: '/console', label: t('console'), icon: TerminalSquareIcon }, { to: '/machines', label: t('machines'), icon: NetworkIcon }, { to: '/files', label: t('files'), icon: FileIcon }, { to: '/resources', label: t('resources'), icon: ActivityIcon }, { to: '/tools', label: t('tools'), icon: WrenchIcon }, { to: '/skills', label: t('skills'), icon: BookOpenIcon }, { to: '/settings', label: t('settings'), icon: Settings2Icon }]
  return <SidebarProvider><Sidebar><SidebarHeader><div className="flex items-center gap-2 px-2 py-1 font-heading text-lg font-semibold"><TerminalSquareIcon />Mobius</div></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupLabel>{t('machine')}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{nav.map(({ to, label, icon: Icon }) => <SidebarMenuItem key={to}><SidebarMenuButton asChild tooltip={label}><NavLink to={to} className={({ isActive }) => isActive ? 'font-medium' : ''}><Icon /><span>{label}</span></NavLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter><div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><ServerIcon />{status.data?.hostname ?? t('connecting')}</div><DropdownMenu><DropdownMenuTrigger asChild><Button className="self-center" variant="ghost" size="icon-sm"><LanguagesIcon /><span className="sr-only">{t('language')}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={language} onValueChange={(value) => setLanguage(value as Language)}><DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem><DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><Button variant="ghost" size="sm" onClick={toggleTheme}><MonitorCogIcon data-icon="inline-start" />{dark ? t('light') : t('dark')}</Button><Button variant="ghost" size="sm" onClick={async () => { await sdk?.session.logout(); navigate('/console') }}>{t('signOut')}</Button></SidebarFooter></Sidebar><SidebarInset><header className="flex h-14 items-center gap-3 border-b px-4"><SidebarTrigger><PanelLeftIcon /></SidebarTrigger><Separator orientation="vertical" className="h-4" /><div className="min-w-0"><p className="truncate text-sm font-medium">{status.data?.hostname ?? t('loadingMachine')}</p></div><Badge className="ml-auto" variant="secondary">{t('online')}</Badge></header><Routes><Route path="/console" element={<Console token={token} />} /><Route path="/machines" element={<Machines token={token} />} /><Route path="/files" element={<FilesPage token={token} />} /><Route path="/resources" element={<ResourcesPage token={token} />} /><Route path="/tools" element={<ToolsetsPage token={token} />} /><Route path="/skills" element={<SkillsPage token={token} />} /><Route path="/settings" element={<SettingsPage token={token} />} /><Route path="*" element={<Navigate to="/console" replace />} /></Routes></SidebarInset></SidebarProvider>
}

function Console({ token }: { token: string }) {
  const { t } = useUi()
  const conversationQuery = useQuery({ queryKey: ['conversation'], queryFn: () => api<ChatMessage[]>('/api/conversation', token), refetchOnWindowFocus: false })
  const [conversation, setConversation] = useState<ConversationItem[]>([]); const conversationRef = useRef(conversation); const queueRef = useRef<{ id: string; message: ChatMessage }[]>([]); const activeRef = useRef<{ id: string; controller: AbortController } | null>(null); const recorderRef = useRef<MediaRecorder | null>(null)
  const [draft, setDraft] = useState(''); const [activeRun, setActiveRun] = useState<string | null>(null); const [contextTokens, setContextTokens] = useState<number | null>(null); const [error, setError] = useState(''); const [recording, setRecording] = useState(false); const [transcribing, setTranscribing] = useState(false); const [conversationInitialized, setConversationInitialized] = useState(false)
  const updateConversation = (next: ConversationItem[]) => { conversationRef.current = next; setConversation(next) }
  useEffect(() => { if (!conversationQuery.data || activeRef.current) return; updateConversation(conversationQuery.data.map((message) => ({ kind: 'message', id: crypto.randomUUID(), message, queued: false }))); setConversationInitialized(true) }, [conversationQuery.data])
  useEffect(() => () => { const recorder = recorderRef.current; recorderRef.current = null; if (recorder?.state !== 'inactive') recorder?.stop(); recorder?.stream.getTracks().forEach((track) => track.stop()) }, [])
  const drain = async (): Promise<void> => { if (activeRef.current || queueRef.current.length === 0) return; const next = queueRef.current.shift()!; updateConversation(conversationRef.current.map((item) => item.kind === 'message' && item.id === next.id ? { ...item, queued: false } : item)); const runId = crypto.randomUUID(); const controller = new AbortController(); activeRef.current = { id: runId, controller }; setActiveRun(runId); setError(''); try { await streamAgentTurn(token, runId, next.message, controller.signal, (event) => { if (event.type === 'tool_call') updateConversation([...conversationRef.current, { kind: 'tool', call_id: event.call_id, name: event.name, arguments: event.arguments, complete: false }]); if (event.type === 'tool_result') updateConversation(conversationRef.current.map((item) => item.kind === 'tool' && item.call_id === event.call_id ? { ...item, complete: true, added_lines: event.added_lines, deleted_lines: event.deleted_lines } : item)); if (event.type === 'context') setContextTokens(event.input_tokens); if (event.type === 'complete') updateConversation([...conversationRef.current, { kind: 'message', id: crypto.randomUUID(), message: event.message, queued: false }]) }) } catch (cause) { if (!controller.signal.aborted) setError(message(cause)) } finally { activeRef.current = null; setActiveRun(null); void drain() } }
  const submit = (event: FormEvent) => { event.preventDefault(); const content = draft.trim(); if (!content) return; const queued = activeRef.current !== null || queueRef.current.length > 0; const entry: Extract<ConversationItem, { kind: 'message' }> = { kind: 'message', id: crypto.randomUUID(), message: { role: 'user', content }, queued }; updateConversation([...conversationRef.current, entry]); queueRef.current.push({ id: entry.id, message: entry.message }); setDraft(''); void drain() }
  const stop = async () => { const active = activeRef.current; if (!active) return; queueRef.current = []; updateConversation(conversationRef.current.filter((item) => item.kind !== 'message' || !item.queued)); active.controller.abort(); await api(`/api/agent/turn/${active.id}`, token, { method: 'DELETE' }).catch(() => undefined) }
  const toggleRecording = async () => {
    const current = recorderRef.current
    if (current) { if (current.state !== 'inactive') current.stop(); return }
    let stream: MediaStream | null = null
    try {
      const recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream = recordingStream
      const recorder = new MediaRecorder(recordingStream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onstop = () => {
        if (recorderRef.current !== recorder) return
        recorderRef.current = null
        recordingStream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (!audio.size) return
        setTranscribing(true)
        void transcribeAudio(token, audio).then(({ text }) => setDraft(text)).catch((cause: unknown) => setError(message(cause))).finally(() => setTranscribing(false))
      }
      recorderRef.current = recorder
      recorder.start()
      setError('')
      setRecording(true)
    } catch (cause) { stream?.getTracks().forEach((track) => track.stop()); setError(message(cause)) }
  }
  const unavailable = conversationQuery.isLoading || Boolean(conversationQuery.error) || transcribing
  return <main className="flex h-[calc(100svh-3.5rem)] flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><div><h1 className="font-heading text-lg font-semibold">{t('console')}</h1><p className="text-sm text-muted-foreground">{t('consoleDescription')}</p></div><Badge className="ml-auto" variant="outline">{t('context')}: {contextTokens?.toLocaleString() ?? '—'} {t('tokens')}</Badge>{activeRun && <Button variant="destructive" size="sm" onClick={stop}><CircleStopIcon data-icon="inline-start" />{t('stop')}</Button>}</div>{conversationInitialized ? <MessageScrollerProvider autoScroll={false} defaultScrollPosition="end"><MessageScroller className="flex-1"><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl p-4">{conversation.map((item) => <MessageScrollerItem key={item.kind === 'tool' ? item.call_id : item.id} className="[content-visibility:visible] [contain-intrinsic-size:auto]"><ConversationEntry item={item} /></MessageScrollerItem>)}{activeRun && <MessageScrollerItem className="[content-visibility:visible] [contain-intrinsic-size:auto]"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('agentWorking')}</div></MessageScrollerItem>}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" /></MessageScroller></MessageScrollerProvider> : <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div>}{conversationQuery.error && <div className="px-4 pb-2"><ErrorAlert error={message(conversationQuery.error)} /></div>}{error && <div className="px-4 pb-2"><ErrorAlert error={error} /></div>}<form className="border-t p-4" onSubmit={submit}><InputGroup className="mx-auto max-w-4xl"><InputGroupTextarea disabled={unavailable} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={activeRun ? t('queuedPlaceholder') : t('outcomePlaceholder')} rows={2} /><InputGroupAddon align="inline-end"><InputGroupButton aria-label={recording ? t('stopRecording') : t('startRecording')} disabled={unavailable} onClick={() => void toggleRecording()} size="icon-sm" variant={recording ? 'destructive' : 'ghost'}>{recording ? <SquareIcon /> : <MicIcon />}</InputGroupButton><InputGroupButton disabled={unavailable} type="submit" variant="default" size="icon-sm"><SendIcon /><span className="sr-only">{t('console')}</span></InputGroupButton></InputGroupAddon></InputGroup><p className="mx-auto mt-2 max-w-4xl text-xs text-muted-foreground">{transcribing ? t('transcribing') : t('composeHint')}{queueRef.current.length > 0 ? ` · ${queueRef.current.length} ${t('queuedCount')}` : ''}</p></form></main>
}

function ConversationEntry({ item }: { item: ConversationItem }) {
  const { language, t } = useUi()
  if (item.kind === 'tool') {
    const path = typeof item.arguments.path === 'string' ? item.arguments.path : ''
    const command = typeof item.arguments.command === 'string' ? item.arguments.command : ''
    const action = item.complete ? {
      list_files: t('listedFiles'), read_file: t('readFile'), write_file: t('wroteFile'), edit_file: t('wroteFile'), run_bash: t('ranCommand'), web_search: t('searchedWeb'), image_generation: t('generatedImage'),
    }[item.name] : {
      list_files: t('listingFiles'), read_file: t('readingFile'), write_file: t('writingFile'), edit_file: t('writingFile'), run_bash: t('runningCommand'), web_search: t('searchingWeb'), image_generation: t('generatingImage'),
    }[item.name]
    const target = command || path || item.name
    const changes = item.complete && (item.name === 'write_file' || item.name === 'edit_file') && item.added_lines !== undefined && item.deleted_lines !== undefined ? ` · ${t('addedLines')} ${item.added_lines ?? 0} ${t('lines')} · ${t('deletedLines')} ${item.deleted_lines ?? 0} ${t('lines')}` : ''
    return <div className="flex items-start gap-2 text-sm text-muted-foreground">{item.complete ? <CheckIcon className="mt-0.5 size-4 text-foreground" /> : <Spinner className="mt-0.5" />}<span className="break-all">{action ?? item.name} <code className="font-mono text-foreground">{target}</code>{changes}</span></div>
  }
  if (item.message.role !== 'assistant') return <Message align="end"><MessageContent><Card size="sm"><CardContent className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></CardContent></Card></MessageContent></Message>
  const timestamp = item.message.created_at ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.message.created_at)) : null
  const duration = item.message.duration_ms === undefined ? null : `${t('duration')}: ${(item.message.duration_ms / 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })} ${t('seconds')}`
  const tokens = item.message.input_tokens === undefined || item.message.output_tokens === undefined ? null : `${(item.message.input_tokens + item.message.output_tokens).toLocaleString()} ${t('tokens')}`
  return <Message><MessageContent className="gap-1.5"><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></div>{item.message.images?.map((image) => <Card key={image.id} size="sm"><CardContent className="p-0"><img alt={t('generatedImage')} className="max-w-full" src={`data:image/png;base64,${image.data}`} /></CardContent></Card>)}<MessageFooter className="gap-2 px-0 font-normal">{[timestamp, duration, tokens].filter(Boolean).map((detail) => <span key={detail}>{detail}</span>)}</MessageFooter></MessageContent></Message>
}

function Machines({ token }: { token: string }) {
  const { t } = useUi()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) })
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [error, setError] = useState('')
  const add = async (event: FormEvent) => { event.preventDefault(); try { await api('/api/peers', token, { method: 'POST', body: JSON.stringify({ name, base_url: baseUrl }) }); setName(''); setBaseUrl(''); await peers.refetch() } catch (cause) { setError(message(cause)) } }
  return <Page title={t('machinesTitle')} description={t('machinesDescription')}><Card><CardHeader><CardTitle>{t('enrolledMachines')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">{peers.data?.map((peer) => <div key={peer.id} className="flex items-center gap-3"><ServerIcon /><div className="min-w-0 flex-1"><p className="font-medium">{peer.name}</p><p className="truncate text-sm text-muted-foreground">{peer.base_url}</p></div><Button aria-label={`${t('remove')}: ${peer.name}`} title={t('remove')} variant="ghost" size="icon-sm" onClick={async () => { await api(`/api/peers/${peer.id}`, token, { method: 'DELETE' }); await peers.refetch() }}><XIcon /></Button></div>)}{peers.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('noMachines')}</p>}</CardContent></Card><Card><CardHeader><CardTitle>{t('addMachine')}</CardTitle></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={add}><FieldGroup><Field><FieldLabel htmlFor="peer-name">{t('name')}</FieldLabel><Input id="peer-name" value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field><FieldLabel htmlFor="peer-url">{t('mobiusUrl')}</FieldLabel><Input id="peer-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field></FieldGroup>{error && <ErrorAlert error={error} />}<Button><PlusIcon data-icon="inline-start" />{t('add')}</Button></form></CardContent></Card></Page>
}

function FilesPage({ token }: { token: string }) {
  const { t } = useUi()
  const [path, setPath] = useState('/')
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [content, setContent] = useState('')
  const files = useQuery({ queryKey: ['files', path], queryFn: () => api<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`, token) })
  const open = async (entry: FileEntry) => { if (entry.kind === 'directory') { setPath(entry.path); return } setSelected(entry); const result = await api<{ content: string }>(`/api/files/read?path=${encodeURIComponent(entry.path)}`, token); setContent(result.content) }
  return <Page title={t('filesTitle')} description={t('filesDescription')}><Card><CardContent className="pt-4"><InputGroup><Input aria-label={t('directory')} value={path} onChange={(event) => setPath(event.target.value)} /><InputGroupAddon align="inline-end"><InputGroupButton onClick={() => files.refetch()}><RefreshCwIcon data-icon="inline-start" />{t('refresh')}</InputGroupButton></InputGroupAddon></InputGroup></CardContent></Card><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle>{t('directory')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-1">{files.data?.map((entry) => <Button key={entry.path} variant="ghost" className="justify-start" onClick={() => open(entry)}>{entry.kind === 'directory' ? <FolderIcon data-icon="inline-start" /> : <FileIcon data-icon="inline-start" />}{entry.name}</Button>)}</CardContent></Card><Card><CardHeader><CardTitle>{selected?.path ?? t('selectFile')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-3"><Textarea aria-label={selected?.path ?? t('selectFile')} value={content} onChange={(event) => setContent(event.target.value)} disabled={!selected} className="min-h-80 font-mono" /><Button disabled={!selected} onClick={() => selected && api('/api/files/write', token, { method: 'PUT', body: JSON.stringify({ path: selected.path, content }) })}>{t('save')}</Button></CardContent></Card></div></Page>
}

function ResourcesPage({ token }: { token: string }) {
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

function SkillsPage({ token }: { token: string }) {
  const { t } = useUi()
  const query = useQuery({ queryKey: ['skills'], queryFn: () => api<Skills>('/api/skills', token), refetchInterval: 2000 })
  if (query.error) return <Page title={t('skillsTitle')} description={t('skillsDescription')}><ErrorAlert error={message(query.error)} /></Page>
  if (!query.data) return <Page title={t('skillsTitle')} description={t('skillsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('skillsTitle')} description={t('skillsDescription')}><Card><CardHeader><CardTitle>{t('skillsDirectory')}</CardTitle><CardDescription><code>{query.data.directory}</code></CardDescription></CardHeader></Card><div className="grid gap-4 md:grid-cols-2">{query.data.skills.map((skill) => <Card key={skill.directory}><CardHeader><CardTitle>{skill.name}</CardTitle><CardDescription>{skill.description || '—'}</CardDescription></CardHeader><CardContent><p className="text-xs text-muted-foreground">{t('skillDirectory')}</p><code className="break-all text-sm">{skill.directory}</code></CardContent></Card>)}</div>{query.data.skills.length === 0 && <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('noSkills')}</CardContent></Card>}</Page>
}

function ToolsetsPage({ token }: { token: string }) {
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

function SettingsPage({ token }: { token: string }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings', token) })
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setModel(settings.data?.default_model ?? '')
    setBaseUrl(settings.data?.openai_base_url ?? '')
    setApiKey(settings.data?.openai_api_key ?? '')
  }, [settings.data])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = await api<Settings>('/api/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ default_model: model, openai_base_url: baseUrl, openai_api_key: apiKey }),
      })
      queryClient.setQueryData(['settings'], saved)
      setError('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setSaving(false)
    }
  }

  if (settings.error) return <Page title={t('settingsTitle')} description={t('settingsDescription')}><ErrorAlert error={message(settings.error)} /></Page>
  if (!settings.data) return <Page title={t('settingsTitle')} description={t('settingsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>

  return <Page title={t('settingsTitle')} description={t('settingsDescription')}><Card><CardHeader><CardTitle>{t('settingsTitle')}</CardTitle><CardDescription>{t('settingsDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={save}><FieldGroup><Field><FieldLabel htmlFor="model">{t('modelId')}</FieldLabel><Input id="model" value={model} onChange={(event) => setModel(event.target.value)} required /><FieldDescription>{t('modelHint')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-base-url">{t('baseUrl')}</FieldLabel><Input id="openai-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><FieldDescription>{t('baseUrlDescription')}</FieldDescription></Field><Field><FieldLabel htmlFor="openai-api-key">{t('apiKey')}</FieldLabel><Input id="openai-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /><FieldDescription>{t('apiKeyDescription')}</FieldDescription></Field></FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{t('saveChanges')}</Button></form></CardContent></Card></Page>
}

function Page({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6"><div><h1 className="font-heading text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>{children}</main> }
function ErrorAlert({ error }: { error: string }) { const { t } = useUi(); return <Alert variant="destructive"><AlertTitle>{t('requestFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><TooltipProvider><UiProvider><HashRouter><App /></HashRouter></UiProvider></TooltipProvider></QueryClientProvider>)
