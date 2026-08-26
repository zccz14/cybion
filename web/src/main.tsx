import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuthMiniApi } from 'auth-mini/sdk/browser'
import { AuthMiniButton, AuthMiniProvider, useAuthMini } from 'auth-mini-react-components'
import { ActivityIcon, AlertTriangleIcon, ArrowLeftIcon, BookOpenIcon, BrainCircuitIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, CircleStopIcon, CopyIcon, CpuIcon, DatabaseIcon, DownloadIcon, ExternalLinkIcon, FileIcon, FileTextIcon, GitForkIcon, Globe2Icon, HardDriveIcon, ImageIcon, LanguagesIcon, MemoryStickIcon, MicIcon, MonitorCogIcon, NetworkIcon, PanelLeftIcon, PaperclipIcon, RefreshCwIcon, SearchIcon, SendIcon, ServerIcon, Settings2Icon, SquareIcon, TerminalSquareIcon, UploadIcon, Volume2Icon, WrenchIcon, XIcon } from 'lucide-react'
import { createContext, FormEvent, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { HashRouter, Link, NavLink, Navigate, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { TooltipProvider } from '@/components/ui/tooltip'
import { requireWebmOpusMimeType, transcriptionFormData } from './audio'
import './styles.css'

declare global { interface Window { __CYBION_AUTH_URL: string | null } }

type DeploymentRole = 'controller' | 'executor'
type Status = { machine_id: string; hostname: string; root_user_id: string; auth_url: string; openai_base_url: string; deployment_role: DeploymentRole }
type Settings = { default_model: string; subthread_model: string; voice_script_model: string; voice_turn_model: string; voice_script_max_chars: number; edge_tts_zh_voice: string; edge_tts_en_voice: string; openai_base_url: string; openai_api_key: string; context_window_limit: number | null }
type ExecutorPairing = { pairing_url: string; expires_at: string }
type UpdateStatus = { current_version: string; latest_version: string | null; state: 'checking' | 'current' | 'ready' | 'failed'; detail: string }
type ExecutorResources = { cpu: { usage_percent: number; load_1m: number; logical_cpus: number }; memory: { used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number }; network: { receive_bytes_per_second: number; transmit_bytes_per_second: number; interfaces: number }; disk: { used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number } | null }
type Peer = { id: string; name: string; machine_id: string; hostname: string; deployment_role: DeploymentRole; created_at: string; last_seen_at: string | null; online: boolean; resource_status: 'online' | 'stale' | 'unavailable'; resource: ExecutorResources | null; resource_sampled_at: string | null }
type SystemResources = { sampled_at: number; sample_interval_ms: number; cpu: { usage_percent: number; load_1m: number; logical_cpus: number }; memory: { used_bytes: number; total_bytes: number; available_bytes: number; process_used_bytes: number; other_used_bytes: number; usage_percent: number; swap_used_bytes: number; swap_total_bytes: number }; network: { receive_bytes_per_second: number; transmit_bytes_per_second: number; interfaces: number }; disk: { mount_point: string; used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number } | null; sqlite: { main_bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number; freelist_bytes: number; freelist_percent: number } }
type StoredFile = { id: string; filename: string; mime_type: string; size: number; preview_content?: string; history_entry_id?: number; created_at: string }
type GeneratedImage = { id: string; data?: string; preview_content?: string; history_entry_id?: number }
type ChatMessage = { id?: number; role: string; content: string | null; images?: GeneratedImage[]; created_at?: string; duration_ms?: number; input_tokens?: number; output_tokens?: number }
type Transcription = { text: string }
type VoiceScript = { text: string }
type VoiceTurnDecision = { action: 'continue' | 'submit' | 'discard' | 'confirm'; relation: 'new_command' | 'answer' | 'addendum' | 'correction' | 'filler' }
type VoicePreview = { state: 'armed' | 'listening' | 'transcribing' | 'deciding' | 'confirm'; transcript: string }
type Skill = { name: string; description: string; directory: string }
type Skills = { directory: string; skills: Skill[] }
type AgentEvent = { type: 'status'; stage: 'queued' | 'running' | 'checkpointing' | 'retrying'; message: string } | { type: 'checkpoint'; id: number } | { type: 'tool_call'; call_id: string; name: string; arguments: Record<string, unknown>; started_at?: string } | { type: 'tool_result'; call_id: string; name: string; added_lines: number | null; deleted_lines: number | null; output?: string; output_bytes?: number; finished_at?: string } | { type: 'context'; input_tokens: number } | { type: 'complete'; message: ChatMessage } | { type: 'error'; error: string }
type SubthreadReference = { id: string; from_record_id: number; title: string; task: string; model: string; goal_state: GoalState; status: Subthread['status'] }
type ConversationItem = { kind: 'message'; id: string; message: ChatMessage; queued: boolean } | { kind: 'tool'; id: string; call_id: string; name: string; arguments: Record<string, unknown>; complete: boolean; output?: string; started_at?: string; finished_at?: string; added_lines?: number | null; deleted_lines?: number | null; subthread?: SubthreadReference; subthreadAction?: 'fork' | 'cancel' | 'retry' } | { kind: 'reasoning'; id: string; summary: string } | { kind: 'handoff'; id: string; subthreadId: string; terminalState: string; result: string; detail: string; subthread?: SubthreadReference } | { kind: 'fallback'; id: string; label: string }
type ThreadHistoryRecord = { id: number; kind: 'input' | 'response_output' | 'tool_output' | 'checkpoint'; payload: Record<string, unknown>; created_at: string; images: GeneratedImage[] }
type ThreadHistoryPage = { records: ThreadHistoryRecord[]; subthreads: SubthreadReference[]; next_after_id: number; next_before_id?: number; has_more: boolean; active: boolean }
type AcceptedAgentTurn = { record_id: number }
type HistoryRecordSummary = { id: number; thread_id: string | null; kind: string; created_at: string; payload_bytes: number; role: string | null; item_type: string | null; name: string | null; call_id: string | null; summary: string }
type HistoryRecordPage = { records: HistoryRecordSummary[]; total: number; page: number; page_size: number }
type HistoryRecordDetail = { id: number; thread_id: string | null; kind: string; created_at: string; payload: unknown }
type HistoryRecordFilter = { itemType: string; kind: string; role: string; name: string; threadId: string; callId: string }
type GoalState = 'active' | 'achieved' | 'blocked' | 'cancelled'
type Subthread = { id: string; title: string; task: string; completion_criteria: string; goal_state: GoalState; goal_evidence: string | null; blocked_reason: string | null; status: 'queued' | 'running' | 'retrying' | 'completed' | 'cancelled' | 'failed'; model: string; result: string | null; retry_attempt: number; next_retry_at: number | null; context_window_limit: number | null; created_at: string; updated_at: string }
type MainThreadSummary = { status: 'idle' | 'running' | 'retrying'; model: string; updated_at: string | null }
type ThreadIndex = { main_thread: MainThreadSummary; subthreads: Subthread[]; total: number; page: number; page_size: number; has_more: boolean; models: string[] }
type GoalThreadStatus = 'active' | 'all' | 'terminal' | 'completed' | 'blocked' | 'cancelled'
type SubthreadDetail = { thread: Subthread }
type SubthreadStreamMessage = { type: 'event'; event: AgentEvent } | { type: 'reaped' }
type Language = 'en' | 'zh'
type ToolDefinition = { type: string; name?: string; description?: string; parameters?: unknown }
type ToolCatalog = { tools: ToolDefinition[] }
type BrowserApproval = { id: string; description: string }
type BrowserSession = { id: string; computer_use_enabled: boolean; created_at: string; url: string; pending_approval?: BrowserApproval; target_device: string; target_name: string }
type CommandRun = { id: string; command: string; target_machine_id: string; target_machine_name: string; started_at: string; completed_at: string | null; result: string | null; exit_code: number | null; status: 'running' | 'cancelled' | 'complete' }
type CommandTarget = { id: string; name: string }
type CommandRunPage = { items: CommandRun[]; total: number; page: number; page_size: number; target_machines: CommandTarget[] }
type ReasoningAuditStatus = 'in_flight' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
type ReasoningAudit = { id: number; thread_id: string | null; thread_title: string | null; thread_task: string | null; idx_head: number | null; idx_tail: number | null; request_kind: string; model: string; status: ReasoningAuditStatus; started_at: string; finished_at: string | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null; openai_lb_request_id: string | null; error: string | null }
type ReasoningAuditThread = { id: string; title: string | null; task: string | null }
type ReasoningAuditPage = { items: ReasoningAudit[]; total: number; page: number; page_size: number; threads: ReasoningAuditThread[]; models: string[]; request_kinds: string[] }
type ReasoningAuditFilter = { page: number; pageSize: number; status: ReasoningAuditStatus | 'all'; threadId: string; model: string; requestKind: string }
type Insights = { range: '24h' | '7d' | '30d' | 'all'; generated_at: string; tokens: { completed_requests: number; input_tokens: number; output_tokens: number; total_tokens: number; cached_tokens: number; cache_hit_rate: number | null }; requests: { total: number; completed: number; in_flight: number; failed: number; cancelled: number; interrupted: number }; history: { total_records: number; payload_bytes: number; checkpoint_count: number; latest_record_at: string | null; kinds: { key: string; count: number }[] }; dimensions: { thread_ids: string[]; models: string[]; request_kinds: string[] } }
type InsightFilter = { range: Insights['range']; threadId: string; model: string; requestKind: string }
const goalCopy = {
  en: { goals: 'Goals', description: 'Each delegated Goal keeps looping until it is achieved, blocked, or cancelled.', goal: 'Goal', objective: 'Objective', doneWhen: 'Done when', state: 'Goal state', active: 'Active', achieved: 'Achieved', blocked: 'Blocked', cancelled: 'Cancelled', evidence: 'Evidence', blocker: 'Blocker', outcome: 'Outcome', execution: 'Execution', history: 'Event history', back: 'Back to goals', title: 'Title', actions: 'Actions' },
  zh: { goals: '目标', description: '每个委派目标都会持续循环，直到达成、受阻或取消。', goal: '目标', objective: '目标说明', doneWhen: '完成条件', state: '目标状态', active: '进行中', achieved: '已达成', blocked: '已受阻', cancelled: '已取消', evidence: '证据', blocker: '受阻原因', outcome: '最终结果', execution: '执行状态', history: '事件历史', back: '返回目标', title: '名称', actions: '操作' },
} as const
const words = {
  en: {
    machine: 'Machine', console: 'Console', machines: 'Machines', commands: 'Commands', resources: 'Resources', tools: 'Tools', skills: 'Skills', settings: 'Settings', navWork: 'Work', navAudit: 'Audit', navSystem: 'System', navConfiguration: 'Configuration', connecting: 'Connecting…', loadingMachine: 'Loading machine', online: 'Online', light: 'Light', dark: 'Dark', language: 'Language',
    consoleDescription: 'Agent activity is streamed as it happens.', insights: 'Insights', insightsTitle: 'Operational insights', insightsDescription: 'Completed Responses usage and immutable protocol history, aggregated in UTC without replaying individual rows.', insightsRange: 'Time range', insights24h: 'Last 24 hours', insights7d: 'Last 7 days', insights30d: 'Last 30 days', insightsAll: 'All time', insightsThread: 'Thread', insightsModel: 'Model', insightsKind: 'Request type', insightsAllThreads: 'All threads', insightsMainThread: 'Main thread', insightsAllModels: 'All models', insightsAllKinds: 'All request types', insightsClearFilters: 'Clear filters', insightsGenerated: 'Aggregated {time}', insightsTokenUsage: 'Token usage', insightsCompletedRequests: 'Completed requests', insightsInput: 'Input tokens', insightsOutput: 'Output tokens', insightsTotal: 'Total tokens', insightsCached: 'Cached input', insightsCacheRate: 'Cache hit rate', insightsCacheFormula: 'Cached input ÷ completed input. Cached tokens are a subset of input tokens.', insightsCacheUnavailable: 'No completed input tokens in this range.', insightsRequestHealth: 'Request outcomes', insightsHistory: 'Protocol history', insightsHistoryDescription: 'Immutable records retained for replay and checkpoint context.', insightsHistoryRecords: 'Records', insightsPayloadBytes: 'Payload bytes', insightsCheckpoints: 'Checkpoints', insightsLatestRecord: 'Latest record', insightsDistribution: 'History distribution', historyRecords: 'History records', historyRecordsTitle: 'History records', historyRecordsDescription: 'Inspect the append-only protocol history through compact metadata, then expand only the record you need.', historyRecord: 'Record', historyRecordType: 'Kind', historyRecordRole: 'Role', historyRecordItemType: 'Item type', historyRecordCreatedAt: 'Created', historyRecordSize: 'Payload size', historyRecordLinks: 'Links', historyRecordSummary: 'Summary', historyRecordView: 'View payload', historyRecordPayload: 'Full payload', historyRecordEmpty: 'No history records yet.', historyRecordRange: '{from}–{to} of {total} records', historyRecordPage: 'Page {page} of {pages}', historyRecordPreviousPage: 'Previous', historyRecordNextPage: 'Next', historyRecordPageSize: 'Per page', historyRecordFilters: 'Filters', historyRecordFilterType: 'Payload type', historyRecordFilterKind: 'Kind', historyRecordFilterRole: 'Role', historyRecordFilterName: 'Tool name', historyRecordFilterThread: 'Thread ID', historyRecordFilterCall: 'Call ID', historyRecordAll: 'All', historyRecordApplyFilters: 'Apply filters', historyRecordClearFilters: 'Clear filters', historyRecordActiveFilters: 'Active filters', historyRecordNoMatches: 'No history records match these filters.', context: 'Context', tokens: 'tokens', duration: 'Duration', seconds: 's', stop: 'Stop', startRecording: 'Start voice input', stopRecording: 'Stop voice input', transcribing: 'Transcribing…', voiceReady: 'Voice ready · start speaking', voiceListening: 'Listening', voiceUnderstanding: 'Understanding the turn…', voiceContinue: 'Keep speaking…', voiceConfirm: 'I heard this. Send it or keep listening?', voiceSend: 'Send', voiceDiscard: 'Discard', agentWorking: 'Agent is working…', greeting: 'I am connected to this machine. Tell me the outcome you want to reach.', queued: 'Queued', completed: 'Completed', calling: 'Calling', listingFiles: 'Listing', listedFiles: 'Listed', readingFile: 'Reading', readFile: 'Read', writingFile: 'Editing', wroteFile: 'Edited', runningCommand: 'Running command', ranCommand: 'Ran command', searchingWeb: 'Searching the web', searchedWeb: 'Searched the web', reasoning: 'Reasoning', reasoningRecorded: 'Reasoning recorded', reasoningSummaryUnavailable: 'Reasoning summary unavailable', reasoningWithheld: 'Reasoning withheld', reasoningPersisted: 'Persisted', skillLoading: 'Loading skill', skillLoaded: 'Skill loaded', resourceReading: 'Reading resource', resourceRead: 'Resource read', goalHandoff: 'Goal handoff', delegatedGoal: 'Delegated goal', detailsUnavailable: 'Details unavailable', parameters: 'Parameters', generatingImage: 'Generating image', generatedImage: 'Generated image', addedLines: 'added', deletedLines: 'deleted', lines: 'lines', outcomePlaceholder: 'Describe the outcome you want…', queuedPlaceholder: 'Add a follow-up prompt to the queue…', composeHint: 'Enter to send · Shift+Enter for a new line · IME Enter confirms composition', queuedCount: 'queued',
    machinesTitle: 'Machines', machinesDescription: 'Pair outbound-only tool executors with this controller.', enrolledMachines: 'Registered machines', noMachines: 'No remote machines registered.', pairExecutor: 'Pair executor', pairExecutorDescription: 'Create a one-time command for a device that has no public address, web console, or Auth Mini login.', pairingCommand: 'Run this on the executor', pairingExpires: 'Expires {time}', pairingOneTime: 'This URL is single-use. The executor stores only its controller URL and device access token.', copy: 'Copy', copied: 'Copied', remove: 'Remove', browser: 'Browser', browserTitle: 'Browser Control', browserDescription: 'Agents autonomously create and control disposable, isolated Chromium sessions.', browserCreateHint: 'Agents create unrestricted sessions when needed. Create one here only for manual takeover.', createBrowser: 'Create browser session', computerUse: 'Enable Computer Use', computerUseHint: 'Visual actions pause for explicit approval before clicks or typing.', noBrowserSessions: 'No browser sessions are active.', selectBrowser: 'Select browser session', noBrowser: 'No browser', closeBrowser: 'Close session', approveAction: 'Approve action', browserInput: 'Type into browser', sendBrowserInput: 'Send input', browserLiveView: 'Live browser view', browserClickHint: 'Click the preview to take over with direct pointer input. Scroll over it with a mouse or trackpad.',
    fileObjects: 'File objects', gallery: 'Gallery', fileObjectsTitle: 'File objects', fileObjectsDescription: 'Content-addressed attachments and generated assets stored by this controller.', galleryTitle: 'Gallery', galleryDescription: 'Generated and uploaded images, indexed by the history that produced them.', uploadFiles: 'Upload attachments', uploadingFiles: 'Uploading…', noFiles: 'No files have been stored yet.', noImages: 'No images have been stored yet.', allFileTypes: 'All types', images: 'Images', documents: 'Documents', media: 'Media', otherFiles: 'Other', fileName: 'Name', fileType: 'Type', fileSize: 'Size', fileId: 'SHA-256', sourceHistory: 'Source history', openOriginal: 'Locate in conversation', download: 'Download', attachment: 'Attach file', attachments: 'Attachments', removeAttachment: 'Remove attachment', historyUnavailable: 'No linked history',
    commandsTitle: 'Commands', commandsDescription: 'Every run_bash invocation is durably recorded. Running commands stay first.', noCommands: 'No commands have been run.', noCommandMatches: 'No commands match these filters.', command: 'Command', commandTarget: 'Target machine', commandStartedAt: 'Started', commandFinishedAt: 'Finished', commandResult: 'Result', commandExitCode: 'Exit code', commandRunning: 'Running', commandCancelled: 'Cancelled', commandComplete: 'Complete', commandSearch: 'Search commands', commandSearchPlaceholder: 'Command, machine, or output', commandAllStatuses: 'All statuses', commandAllMachines: 'All machines', commandClearFilters: 'Clear filters', commandViewResult: 'View result', commandStdout: 'Standard output', commandStderr: 'Standard error', commandNoResult: 'No result yet.', commandRange: '{from}–{to} of {total} commands', commandPage: 'Page {page} of {pages}', commandPreviousPage: 'Previous', commandNextPage: 'Next', commandPageSize: 'Per page',
    resourcesTitle: 'Resources', resourcesDescription: 'Live capacity and local database usage.', sampled: 'Sampled', cpu: 'CPU', memory: 'Memory', network: 'Network', disk: 'Disk', sqlite: 'SQLite database', load1m: '1m load', logicalCpus: 'Logical CPUs', processMemory: 'Cybion RSS', otherMemory: 'Other system usage', available: 'Available', swap: 'Swap', received: 'Received', transmitted: 'Transmitted', interfaces: 'Interfaces', mount: 'Mount', main: 'Main', wal: 'WAL', shm: 'SHM', reclaimable: 'Reclaimable', unavailable: 'Unavailable',
    settingsTitle: 'Settings', settingsDescription: 'Configure this machine\'s agent upstream, thread models, and reply announcements.', defaultModel: 'Default model', defaultModelDescription: 'Used by the next agent turn.', modelId: 'Model ID', modelHint: 'Use a model supported by the configured upstream.', voiceScriptModel: 'Voice announcement model', voiceScriptModelHint: 'Rewrites final replies into natural speech before playback.', voiceTurnModel: 'Voice turn model', voiceTurnModelHint: 'Decides whether a recognized voice segment should be sent or kept open.', voiceScriptLength: 'Voice announcement length', voiceScriptLengthHint: 'Maximum characters in the generated script. 150 characters is usually about 30 seconds.', chineseVoice: 'Chinese Edge voice', englishVoice: 'English Edge voice', edgeVoiceHint: 'Use an Edge Neural voice name, for example {voice}.', baseUrlDescription: 'Used for the next agent turn.', apiKeyDescription: 'Used for the next agent turn.', saveChanges: 'Save changes', requestFailed: 'Request failed', initializeCybion: 'Initialize Cybion', initializeDescription: 'Bind this machine to your Auth Mini identity and OpenAI-compatible upstream.', authMiniUrl: 'Auth Mini URL', continueAuth: 'Continue with Auth Mini', apiKey: 'OpenAI API key', baseUrl: 'Base URL', initialize: 'Initialize', returnMachine: 'Return to the machine', signInDescription: 'Sign in through the configured Auth Mini server.', toolsTitle: 'Tools', toolsDescription: 'Every tool sent with a main-thread Responses request.', toolName: 'Tool', toolDescription: 'Description', toolParameters: 'Parameters', noTools: 'No tools are available.', status: 'Status',
    dangerZoneTitle: 'Danger Zone', dangerZoneDescription: 'Irreversible actions for this Cybion controller.', clearConversation: 'Clear conversation history', clearConversationDescription: 'Permanently removes the main conversation, execution history, checkpoints, and every child thread.', clearConversationWarning: 'This cannot be undone. Any active agent work will be stopped before its data is removed.', clearConversationPreserved: 'Machine configuration, enrolled devices, upstream settings, installed skills, browser sessions, and command history stay unchanged.', clearConversationConfirmTitle: 'Clear all conversation data?', clearConversationConfirmDescription: 'Every conversation message, run, event, checkpoint, and child thread will be permanently erased.', clearConversationConfirm: 'Yes, clear conversation', clearingConversation: 'Clearing conversation…', conversationCleared: 'Conversation history cleared.', cancel: 'Cancel',
    updatesTitle: 'Updates', updatesDescription: 'Cybion checks GitHub Releases at startup and every six hours. Downloads are verified before installation.', currentVersion: 'Current version', latestVersion: 'Latest version', checkForUpdates: 'Check for updates', checkingForUpdates: 'Checking for updates…', updateChecking: 'Checking', updateCurrent: 'Up to date', updateReady: 'Ready to install', updateFailed: 'Check failed', restartToInstall: 'Restart and install', restartingToInstall: 'Restarting to install…',
    skillsTitle: 'Skills', skillsDescription: 'Installed skills are watched and applied to the next agent API request.', skillsDirectory: 'Skills directory', installedSkills: 'Installed skills', noSkills: 'No SKILL.md files found.', skillDirectory: 'Installation directory',
    controller: 'Controller', executor: 'Tool executor', deploymentRole: 'Deployment role', controllerDescription: 'Runs the main thread, model inference, and local or remote tools.', executorDescription: 'Connects its local tools back to one controller and does not require a model upstream.', controllerUrl: 'Controller Cybion URL', controllerUrlDescription: 'This executor registers and keeps an outbound SSE connection to the controller when settings are saved.', checkpoint: 'Checkpoint', fullHistory: 'full-history messages', activeInputs: 'active inputs', backgroundWork: 'background tasks', activeTasks: 'Active tasks', activeTasksLoading: 'Loading active tasks…', activeTasksError: 'Active tasks are unavailable.', noActiveTasks: 'No active tasks.', resourceOnline: 'Resource live', resourceStale: 'Resource stale', resourceUnavailable: 'Resource unavailable', resourceReceivedAt: 'Reported {time}', announceReplies: 'Automatic voice announcements', continuousVoice: 'Continuous voice', speakResult: 'Speak', preparingVoice: 'Preparing voice…', showParameters: 'Show parameters', hideParameters: 'Hide parameters', showRunActivity: 'Show activity', hideRunActivity: 'Hide activity', loadEarlierActivity: 'Load earlier activity', loadingActivity: 'Loading activity…', loadEarlierMessages: 'Load earlier messages', loadingEarlierMessages: 'Loading earlier messages…', loadOutput: 'Load output', loadMoreOutput: 'Load more output', loadingOutput: 'Loading output…', mainThreadQueued: 'Queued in the main thread', mainThreadRunning: 'Compiling context', checkpointing: 'Creating checkpoint', retrying: 'Retrying automatically', retryNow: 'Retry now', resendMessage: 'Resend message', resendMessageConfirmTitle: 'Resend this message?', resendMessageConfirmDescription: 'Everything after this message will be permanently removed, then Cybion will reason from this point again.', resendMessageConfirm: 'Resend from here', resendingMessage: 'Resending…', executorOnly: 'This machine is a tool executor. Use a controller Cybion to call its tools.', verifyMachine: 'Registration verifies the shared issuer and root user.', threads: 'Threads', threadsTitle: 'Threads', threadsDescription: 'The main thread stays first, followed by live subthreads that have not been reaped.', noActiveThreads: 'No active subthreads.', threadSearch: 'Search goals', threadSearchPlaceholder: 'Title or task', threadStatusFilter: 'Goal state', threadModelFilter: 'Model', threadAll: 'All', threadAllModels: 'All models', threadClearFilters: 'Clear filters', threadFiltersApplied: 'Filters applied', threadPageSize: 'Per page', threadRange: '{from}–{to} of {total} goals', threadPreviousPage: 'Previous', threadNextPage: 'Next', threadNoMatches: 'No goals match these filters.', terminalAll: 'All finished', thread: 'Thread', threadTask: 'Task', threadModel: 'Model', threadUpdated: 'Updated', threadDetails: 'Thread details', threadDetailsDescription: 'Read-only history and live events from this subthread.', backToThreads: 'Back to threads', events: 'Events', noThreadEvents: 'No events yet.', event: 'Event', time: 'Time', details: 'Details', threadQueued: 'Queued', threadRunning: 'Running', threadRetrying: 'Retrying', threadIdle: 'Idle', mainThread: 'Main thread', mainThreadDescription: 'The single user thread that accepts prompts.', mainThreadModel: 'Main thread model', subthreadModel: 'Subthread model', mainThreadModelHint: 'Used only by the main conversation.', contextWindowLimit: 'Context compaction threshold', contextWindowLimitHint: 'Optional proactive input-token threshold. Leave blank for unlimited; this is not the model context window.', contextWindowUnlimited: 'Unlimited', contextWindowTokens: '{tokens} tokens', subthreadModelHint: 'Captured when each subthread is forked.', reasoningAudit: 'Reasoning audit', reasoningAuditTitle: 'Reasoning audit', reasoningAuditDescription: 'Every Responses request is recorded before it is sent, then completed with status, usage, and the upstream audit link.', reasoningAuditEmpty: 'No reasoning requests match these filters.', reasoningAuditThread: 'Thread', reasoningAuditKind: 'Request type', reasoningAuditModel: 'Model', reasoningAuditContext: 'Context records', reasoningAuditStarted: 'Started', reasoningAuditFinished: 'Finished', reasoningAuditUsage: 'Usage', reasoningAuditCacheRate: 'Cache rate', reasoningAuditOpenAiLb: 'OpenAI LB audit', reasoningAuditError: 'Error', reasoningAuditAllStatuses: 'All statuses', reasoningAuditAllThreads: 'All threads', reasoningAuditMainThread: 'Main thread', reasoningAuditAllModels: 'All models', reasoningAuditAllKinds: 'All request types', reasoningAuditInFlight: 'In flight', reasoningAuditCompleted: 'Completed', reasoningAuditFailed: 'Failed', reasoningAuditCancelled: 'Cancelled', reasoningAuditInterrupted: 'Interrupted by restart', reasoningAuditClearFilters: 'Clear filters', reasoningAuditRange: '{from}–{to} of {total} requests', reasoningAuditPage: 'Page {page} of {pages}', reasoningAuditPreviousPage: 'Previous', reasoningAuditNextPage: 'Next', reasoningAuditPageSize: 'Per page',
    reasoningAuditArchivedThread: 'Archived subthread', reasoningAuditArchivedThreadDescription: 'This thread is no longer available.', reasoningAuditPurpose: 'Purpose', reasoningAuditPurposeNormal: 'Normal reasoning', reasoningAuditPurposeCompaction: 'Context compaction', reasoningAuditPurposeVoiceScript: 'Generate voice script', reasoningAuditPurposeVoiceTurn: 'Voice turn decision',
  },
  zh: {
    machine: '机器', console: '控制台', machines: '机器', commands: '命令', resources: '资源', tools: '工具', skills: '技能', settings: '设置', navWork: '工作', navAudit: '审计', navSystem: '系统', navConfiguration: '配置', connecting: '正在连接…', loadingMachine: '正在加载机器', online: '在线', light: '亮色', dark: '深色', language: '语言',
    consoleDescription: '实时展示 Agent 的执行过程。', insights: '统计洞察', insightsTitle: '运行洞察', insightsDescription: '基于已完成 Responses 请求与不可变协议历史的 UTC 聚合，不重放单条记录。', insightsRange: '时间范围', insights24h: '近 24 小时', insights7d: '近 7 天', insights30d: '近 30 天', insightsAll: '全部时间', insightsThread: '线程', insightsModel: '模型', insightsKind: '请求类型', insightsAllThreads: '全部线程', insightsMainThread: '主线程', insightsAllModels: '全部模型', insightsAllKinds: '全部请求类型', insightsClearFilters: '清除筛选', insightsGenerated: '聚合时间 {time}', insightsTokenUsage: 'Token 用量', insightsCompletedRequests: '已完成请求', insightsInput: '输入 Token', insightsOutput: '输出 Token', insightsTotal: '总 Token', insightsCached: '缓存输入', insightsCacheRate: '缓存率', insightsCacheFormula: '缓存输入 ÷ 已完成请求的输入。缓存 Token 是输入 Token 的子集。', insightsCacheUnavailable: '当前范围没有已完成输入 Token。', insightsRequestHealth: '请求结果', insightsHistory: '协议历史', insightsHistoryDescription: '为重放与 checkpoint 上下文保留的不可变记录。', insightsHistoryRecords: '记录数', insightsPayloadBytes: '负载字节', insightsCheckpoints: '检查点', insightsLatestRecord: '最近记录', insightsDistribution: '历史分布', historyRecords: '历史记录', historyRecordsTitle: '历史记录', historyRecordsDescription: '以紧凑元数据浏览只追加的协议历史，仅在需要时展开具体记录。', historyRecord: '记录', historyRecordType: '类别', historyRecordRole: '角色', historyRecordItemType: '协议类型', historyRecordCreatedAt: '创建时间', historyRecordSize: '负载大小', historyRecordLinks: '关联', historyRecordSummary: '摘要', historyRecordView: '查看负载', historyRecordPayload: '完整负载', historyRecordEmpty: '尚无历史记录。', historyRecordRange: '第 {from}–{to} 条，共 {total} 条记录', historyRecordPage: '第 {page} / {pages} 页', historyRecordPreviousPage: '上一页', historyRecordNextPage: '下一页', historyRecordPageSize: '每页', historyRecordFilters: '筛选条件', historyRecordFilterType: 'Payload 类型', historyRecordFilterKind: '类别', historyRecordFilterRole: '角色', historyRecordFilterName: '工具名称', historyRecordFilterThread: '线程 ID', historyRecordFilterCall: '调用 ID', historyRecordAll: '全部', historyRecordApplyFilters: '应用筛选', historyRecordClearFilters: '清除筛选', historyRecordActiveFilters: '当前筛选', historyRecordNoMatches: '没有符合这些筛选条件的历史记录。', context: '上下文', tokens: 'tokens', duration: '用时', seconds: '秒', stop: '停止', startRecording: '开始语音输入', stopRecording: '停止语音输入', transcribing: '正在转写…', voiceReady: '语音待命，说话即可', voiceListening: '正在听', voiceUnderstanding: '正在判断是否说完…', voiceContinue: '继续补充…', voiceConfirm: '我听到这段内容，要发送还是继续听？', voiceSend: '发送', voiceDiscard: '丢弃', agentWorking: 'Agent 正在执行…', greeting: '我已连接到这台机器。请告诉我你想要达成的结果。', queued: '排队中', completed: '已完成', calling: '正在调用', listingFiles: '正在列出', listedFiles: '已列出', readingFile: '正在读取', readFile: '已读取', writingFile: '正在编辑', wroteFile: '已编辑', runningCommand: '正在运行命令', ranCommand: '已运行命令', searchingWeb: '正在搜索网页', searchedWeb: '已搜索网页', reasoning: '推理', reasoningRecorded: '已记录推理', reasoningSummaryUnavailable: '推理摘要不可用', reasoningWithheld: '推理内容已保留', reasoningPersisted: '已持久化', skillLoading: '正在加载技能', skillLoaded: '已加载技能', resourceReading: '正在读取资源', resourceRead: '已读取资源', goalHandoff: '目标交接', delegatedGoal: '已委派目标', detailsUnavailable: '详情不可用', parameters: '参数', generatingImage: '正在生成图片', generatedImage: '已生成图片', addedLines: '增加', deletedLines: '删除', lines: '行', outcomePlaceholder: '描述你想要的结果…', queuedPlaceholder: '追加一条后续提示词…', composeHint: 'Enter 发送 · Shift+Enter 换行 · 输入法确认候选时不会发送', queuedCount: '条排队中',
    machinesTitle: '机器', machinesDescription: '为仅主动出站的工具执行设备配对。', enrolledMachines: '已注册机器', noMachines: '尚未注册远程机器。', pairExecutor: '配对执行设备', pairExecutorDescription: '为没有公网地址、Web 控制台或 Auth Mini 登录的设备生成一次性命令。', pairingCommand: '在执行设备上运行', pairingExpires: '有效期至 {time}', pairingOneTime: '此 URL 仅能使用一次。执行设备只保存主控地址和设备访问 Token。', copy: '复制', copied: '已复制', remove: '移除', browser: '浏览器', browserTitle: '浏览器控制', browserDescription: 'Agent 会自主创建并控制一次性的隔离 Chromium 会话。', browserCreateHint: 'Agent 会在需要时创建可访问任意网页的会话；仅在你要手动接管时在此创建。', createBrowser: '创建浏览器会话', computerUse: '启用 Computer Use', computerUseHint: '视觉操作在点击或输入前会暂停并请求明确批准。', noBrowserSessions: '当前没有浏览器会话。', selectBrowser: '选择浏览器会话', noBrowser: '不使用浏览器', closeBrowser: '关闭会话', approveAction: '批准操作', browserInput: '向浏览器输入', sendBrowserInput: '发送输入', browserLiveView: '浏览器实时视图', browserClickHint: '点击预览即可直接接管指针输入；可在预览上使用鼠标或触控板滚动。',
    fileObjects: '文件对象', gallery: '图册', fileObjectsTitle: '文件对象', fileObjectsDescription: '由当前控制设备内容寻址保存的附件和生成资产。', galleryTitle: '图册', galleryDescription: '已生成和上传的图片，并按来源历史记录建立索引。', uploadFiles: '上传附件', uploadingFiles: '正在上传…', noFiles: '尚未存储文件。', noImages: '尚未存储图片。', allFileTypes: '全部类型', images: '图片', documents: '文档', media: '媒体', otherFiles: '其他', fileName: '名称', fileType: '类型', fileSize: '大小', fileId: 'SHA-256', sourceHistory: '来源历史', openOriginal: '定位到对话', download: '下载', attachment: '添加附件', attachments: '附件', removeAttachment: '移除附件', historyUnavailable: '没有关联的历史记录',
    commandsTitle: '命令', commandsDescription: '每次 run_bash 调用都会持久化记录；正在运行的命令固定排在前面。', noCommands: '尚未运行任何命令。', noCommandMatches: '没有符合筛选条件的命令。', command: '命令', commandTarget: '目标机器', commandStartedAt: '开始时间', commandFinishedAt: '结束时间', commandResult: '返回结果', commandExitCode: '返回码', commandRunning: '运行中', commandCancelled: '已取消', commandComplete: '已完成', commandSearch: '搜索命令', commandSearchPlaceholder: '命令、机器或输出', commandAllStatuses: '全部状态', commandAllMachines: '全部机器', commandClearFilters: '清除筛选', commandViewResult: '查看返回结果', commandStdout: '标准输出', commandStderr: '标准错误', commandNoResult: '尚无返回结果。', commandRange: '第 {from}–{to} 条，共 {total} 条命令', commandPage: '第 {page} / {pages} 页', commandPreviousPage: '上一页', commandNextPage: '下一页', commandPageSize: '每页',
    resourcesTitle: '系统资源', resourcesDescription: '实时容量和本地数据库占用。', sampled: '采样时间', cpu: 'CPU', memory: '内存', network: '网络', disk: '磁盘', sqlite: 'SQLite 数据库', load1m: '1 分钟负载', logicalCpus: '逻辑核心', processMemory: 'Cybion RSS', otherMemory: '其他系统占用', available: '可用', swap: '交换分区', received: '接收', transmitted: '发送', interfaces: '网卡', mount: '挂载点', main: '主文件', wal: 'WAL', shm: 'SHM', reclaimable: '可回收', unavailable: '不可用',
    settingsTitle: '设置', settingsDescription: '配置当前机器的 Agent 上游、线程模型和结果朗读。', defaultModel: '默认模型', defaultModelDescription: '用于下一轮 Agent 对话。', modelId: '模型 ID', modelHint: '请输入当前上游支持的模型。', voiceScriptModel: '朗读模型', voiceScriptModelHint: '播放前将最终回复改写为自然口语。', voiceTurnModel: '语音轮次模型', voiceTurnModelHint: '判断一段听写应发送给 Agent 还是继续等待补充。', voiceScriptLength: '朗读字数', voiceScriptLengthHint: '生成语音稿的最大字数；150 字通常约为 30 秒。', chineseVoice: '中文 Edge 音色', englishVoice: '英文 Edge 音色', edgeVoiceHint: '使用 Edge Neural 音色名称，例如 {voice}。', baseUrlDescription: '用于下一轮 Agent 对话。', apiKeyDescription: '用于下一轮 Agent 对话。', saveChanges: '保存更改', requestFailed: '请求失败', initializeCybion: '初始化 Cybion', initializeDescription: '将此机器绑定到你的 Auth Mini 身份和 OpenAI 兼容上游。', authMiniUrl: 'Auth Mini 地址', continueAuth: '使用 Auth Mini 继续', apiKey: 'OpenAI API 密钥', baseUrl: '基础地址', initialize: '初始化', returnMachine: '返回机器', signInDescription: '通过已配置的 Auth Mini 服务登录。', toolsTitle: '工具', toolsDescription: '与主线程 Responses 请求一同发送的全部工具。', toolName: '工具', toolDescription: '说明', toolParameters: '参数格式', noTools: '暂时没有可用工具。', status: '状态',
    dangerZoneTitle: '危险操作', dangerZoneDescription: '针对当前 Cybion 控制设备的不可逆操作。', clearConversation: '清空对话记录', clearConversationDescription: '永久删除主对话、执行记录、检查点和全部子线程。', clearConversationWarning: '此操作不可撤销。仍在运行的 Agent 工作会先停止，再删除其数据。', clearConversationPreserved: '机器配置、已接入设备、上游设置、已安装技能、浏览器会话和命令记录不会受到影响。', clearConversationConfirmTitle: '确定清空全部对话数据？', clearConversationConfirmDescription: '每条对话消息、运行和事件、检查点以及子线程都将被永久删除。', clearConversationConfirm: '确认清空对话', clearingConversation: '正在清空对话…', conversationCleared: '已清空对话记录。', cancel: '取消',
    updatesTitle: '版本更新', updatesDescription: 'Cybion 会在启动时及每六小时检查 GitHub Release。安装前会校验下载内容。', currentVersion: '当前版本', latestVersion: '最新版本', checkForUpdates: '检查更新', checkingForUpdates: '正在检查更新…', updateChecking: '检查中', updateCurrent: '已是最新', updateReady: '可以安装', updateFailed: '检查失败', restartToInstall: '重启并安装', restartingToInstall: '正在重启安装…',
    skillsTitle: '技能', skillsDescription: '已安装的技能目录会被监听，并在下一次 Agent API 请求时生效。', skillsDirectory: '技能目录', installedSkills: '已安装技能', noSkills: '未找到 SKILL.md 文件。', skillDirectory: '安装目录',
    controller: '控制设备', executor: '工具执行设备', deploymentRole: '部署角色', controllerDescription: '运行主线程和模型推理，并调用本机或远程工具。', executorDescription: '主动回连一个控制设备以执行本机工具，不需要公网入口或模型上游。', controllerUrl: '控制设备 Cybion URL', controllerUrlDescription: '保存设置时，这台执行设备会注册并持续以 SSE 主动连接控制设备。', checkpoint: '上下文检查点', fullHistory: '条完整历史', activeInputs: '条输入处理中', backgroundWork: '个后台任务', activeTasks: '活动任务', activeTasksLoading: '正在加载活动任务…', activeTasksError: '活动任务暂不可用。', noActiveTasks: '没有活动任务。', resourceOnline: '资源实时', resourceStale: '资源已陈旧', resourceUnavailable: '资源不可用', resourceReceivedAt: '上报于 {time}', announceReplies: '自动语音播报', continuousVoice: '连续语音', speakResult: '播报', preparingVoice: '正在生成语音稿…', showParameters: '展开参数', hideParameters: '收起参数', showRunActivity: '查看执行过程', hideRunActivity: '收起执行过程', loadEarlierActivity: '加载更早执行记录', loadingActivity: '正在加载执行记录…', loadEarlierMessages: '加载更早消息', loadingEarlierMessages: '正在加载更早消息…', loadOutput: '加载输出', loadMoreOutput: '继续加载输出', loadingOutput: '正在加载输出…', mainThreadQueued: '已进入主线程队列', mainThreadRunning: '正在编译上下文', checkpointing: '正在创建检查点', retrying: '正在自动重试', retryNow: '立即重试', resendMessage: '重新推理', resendMessageConfirmTitle: '从这条消息重新推理？', resendMessageConfirmDescription: '此消息之后的全部对话将被永久删除，Cybion 会从这里重新开始推理。', resendMessageConfirm: '从这里重新推理', resendingMessage: '正在重新推理…', executorOnly: '这台机器是工具执行设备。请从控制设备上的 Cybion 调用它的工具。', deviceAccess: '设备访问授权', deviceAccessDescription: '为另一台 Cybion 控制设备创建权限受限的 Token；密钥只显示一次。', createDeviceToken: '创建设备 Token', tokenLabel: 'Token 名称', tokenSecret: '请立即复制此密钥', revoke: '撤销', deviceToken: '设备 Token', verifyMachine: '接入时会验证双方使用同一 issuer 和 root user。', threads: '线程', threadsTitle: '线程', threadsDescription: '主线程固定置顶，后面列出尚未回收的实时子线程。', noActiveThreads: '当前没有活动子线程。', threadSearch: '搜索目标', threadSearchPlaceholder: '名称或任务内容', threadStatusFilter: '目标状态', threadModelFilter: '模型', threadAll: '全部', threadAllModels: '全部模型', threadClearFilters: '清除筛选', threadFiltersApplied: '已应用筛选', threadPageSize: '每页', threadRange: '第 {from}–{to} 条，共 {total} 个目标', threadPreviousPage: '上一页', threadNextPage: '下一页', threadNoMatches: '没有符合这些筛选条件的目标。', terminalAll: '全部已结束', thread: '线程', threadTask: '任务', threadModel: '模型', threadUpdated: '更新时间', threadDetails: '线程详情', threadDetailsDescription: '只读查看这个子线程的历史记录与实时事件。', backToThreads: '返回线程列表', events: '事件', noThreadEvents: '暂时没有事件。', event: '事件', time: '时间', details: '详情', threadQueued: '排队中', threadRunning: '运行中', threadRetrying: '正在重试', threadIdle: '空闲', mainThread: '主线程', mainThreadDescription: '唯一可以接收 prompt 的用户主线程。', mainThreadModel: '主线程模型', subthreadModel: '子线程模型', mainThreadModelHint: '仅用于主对话。', contextWindowLimit: '上下文压缩阈值', contextWindowLimitHint: '可选的主动压缩输入 Token 阈值。留空表示不限额；这不是模型上下文窗口。', contextWindowUnlimited: '不限额', contextWindowTokens: '{tokens} tokens', subthreadModelHint: '每个子线程在 fork 时固化该模型。', reasoningAudit: '推理审计', reasoningAuditTitle: '推理审计', reasoningAuditDescription: '每个 Responses 请求在发出前即记录，结束后补齐状态、用量和上游审计链接。', reasoningAuditEmpty: '没有符合这些筛选条件的推理请求。', reasoningAuditThread: '线程', reasoningAuditKind: '请求类型', reasoningAuditModel: '模型', reasoningAuditContext: '上下文记录', reasoningAuditStarted: '发起时间', reasoningAuditFinished: '结束时间', reasoningAuditUsage: '用量', reasoningAuditCacheRate: '缓存率', reasoningAuditOpenAiLb: 'OpenAI LB 审计', reasoningAuditError: '错误', reasoningAuditAllStatuses: '全部状态', reasoningAuditAllThreads: '全部线程', reasoningAuditMainThread: '主线程', reasoningAuditAllModels: '全部模型', reasoningAuditAllKinds: '全部请求类型', reasoningAuditInFlight: '在途', reasoningAuditCompleted: '已完成', reasoningAuditFailed: '失败', reasoningAuditCancelled: '已取消', reasoningAuditInterrupted: '因重启中断', reasoningAuditClearFilters: '清除筛选', reasoningAuditRange: '第 {from}–{to} 条，共 {total} 个请求', reasoningAuditPage: '第 {page} / {pages} 页', reasoningAuditPreviousPage: '上一页', reasoningAuditNextPage: '下一页', reasoningAuditPageSize: '每页',
    reasoningAuditArchivedThread: '已归档子线程', reasoningAuditArchivedThreadDescription: '该线程已不可用。', reasoningAuditPurpose: '用途', reasoningAuditPurposeNormal: '普通推理', reasoningAuditPurposeCompaction: '上下文压缩', reasoningAuditPurposeVoiceScript: '生成语音稿', reasoningAuditPurposeVoiceTurn: '语音轮次判定',
  },
} as const
type TranslationKey = keyof typeof words.en
type GoalCopyKey = keyof typeof goalCopy.en

const queryClient = new QueryClient()
const UiContext = createContext<{ dark: boolean; toggleTheme: () => void; language: Language; setLanguage: (language: Language) => void; t: (key: TranslationKey) => string } | null>(null)
function UiProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('cybion.language') === 'zh' ? 'zh' : 'en')
  const [dark, setDark] = useState(() => localStorage.getItem('cybion.theme') === 'dark' || (!localStorage.getItem('cybion.theme') && matchMedia('(prefers-color-scheme: dark)').matches))
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; localStorage.setItem('cybion.language', language) }, [language])
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('cybion.theme', dark ? 'dark' : 'light') }, [dark])
  return <UiContext.Provider value={{ dark, toggleTheme: () => setDark((value) => !value), language, setLanguage, t: (key) => words[language][key] }}>{children}</UiContext.Provider>
}

function useUi() { const value = useContext(UiContext); if (!value) throw new Error('UI context is missing'); return value }
function goalText(language: Language, key: GoalCopyKey) { return goalCopy[language][key] }
function useAuthToken() { const { sdk } = useAuthMini(); if (!sdk) throw new Error('Auth Mini session is missing'); return sdk }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong.' }
function bytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}` }

const browserFrameBoundary = new TextEncoder().encode('--cybion-frame\r\n')
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

async function uploadStoredFile(sdk: AuthMiniApi, file: File): Promise<StoredFile> {
  const data = new FormData()
  data.append('file', file, file.name)
  const response = await authenticatedFetch(sdk, '/api/file-objects', { method: 'POST', body: data })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<StoredFile>
}

async function downloadStoredFile(sdk: AuthMiniApi, file: StoredFile) {
  const response = await authenticatedFetch(sdk, `/api/file-objects/${encodeURIComponent(file.id)}/content`)
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function bootstrapApi<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers } })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<T>
}

async function transcribeAudio(sdk: AuthMiniApi, audio: Blob): Promise<Transcription> {
  const form = transcriptionFormData(audio)
  const response = await authenticatedFetch(sdk, '/api/audio/transcriptions', { method: 'POST', body: form })
  if (!response.ok) { const body = await response.json().catch(() => ({ error: response.statusText })); throw new Error(body.error ?? response.statusText) }
  return response.json() as Promise<Transcription>
}

function decideVoiceTurn(sdk: AuthMiniApi, input: { transcript: string; latest_user_message: string; latest_assistant_message: string }) {
  return api<VoiceTurnDecision>('/api/audio/turn-decision', sdk, { method: 'POST', body: JSON.stringify(input) })
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

async function startAgentTurn(sdk: AuthMiniApi, message: ChatMessage): Promise<AcceptedAgentTurn> {
  return api<AcceptedAgentTurn>('/api/agent/turn', sdk, { method: 'POST', body: JSON.stringify({ message }) })
}

async function resendAgentTurn(sdk: AuthMiniApi, recordId: number): Promise<AcceptedAgentTurn> {
  return api<AcceptedAgentTurn>(`/api/conversation/messages/${recordId}/resend`, sdk, { method: 'POST', body: '{}' })
}

function callbackUrl() { return `${location.origin}${location.pathname}#/auth/callback` }
function audience() { return location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.hostname : undefined }

function App() { return window.__CYBION_AUTH_URL ? <ConfiguredApp authUrl={window.__CYBION_AUTH_URL} /> : <Bootstrap /> }

function AuthProvider({ authUrl, children }: { authUrl: string; children: ReactNode }) {
  return <AuthMiniProvider autoRedirectToLogin authMiniBaseUrl={authUrl} callbackUrl={callbackUrl} audience={audience()}>{children}</AuthMiniProvider>
}

function ConfiguredApp({ authUrl }: { authUrl: string }) { return <AuthProvider authUrl={authUrl}><Workspace /></AuthProvider> }

function Bootstrap() {
  const [authUrl, setAuthUrl] = useState(() => sessionStorage.getItem('cybion.auth_url') ?? 'https://auth.ntnl.io')
  const updateAuthUrl = (nextAuthUrl: string) => { sessionStorage.setItem('cybion.auth_url', nextAuthUrl); setAuthUrl(nextAuthUrl) }
  return <AuthProvider authUrl={authUrl}><BootstrapForm authUrl={authUrl} setAuthUrl={updateAuthUrl} /></AuthProvider>
}

function BootstrapForm({ authUrl, setAuthUrl }: { authUrl: string; setAuthUrl: (authUrl: string) => void }) {
  const { t } = useUi()
  const { error: authError, isAuthenticated, session } = useAuthMini()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://openai.ntnl.io/v1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setup = async (event: FormEvent) => {
    event.preventDefault()
    const accessToken = session?.accessToken
    if (!accessToken) return
    setBusy(true)
    try {
      await bootstrapApi('/api/setup', accessToken, { method: 'POST', body: JSON.stringify({ auth_url: authUrl, openai_api_key: apiKey, openai_base_url: baseUrl }) })
      location.reload()
    } catch (cause) { setError(message(cause)) } finally { setBusy(false) }
  }
  return <main className="grid min-h-svh place-items-center p-6"><Card className="w-full max-w-lg"><CardHeader><CardTitle>{t('initializeCybion')}</CardTitle><CardDescription>{t('initializeDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-6" onSubmit={setup}><FieldGroup><Field><FieldLabel htmlFor="auth-url">{t('authMiniUrl')}</FieldLabel><Input id="auth-url" value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} required /></Field><Field><FieldLabel htmlFor="api-key">{t('apiKey')}</FieldLabel><Input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></Field><Field><FieldLabel htmlFor="base-url">{t('baseUrl')}</FieldLabel><Input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></Field></FieldGroup>{(error || authError) && <ErrorAlert error={error || authError?.message || ''} />}<Button disabled={busy || !isAuthenticated}>{busy && <Spinner data-icon="inline-start" />}{t('initialize')}</Button></form></CardContent></Card></main>
}

type WorkspaceNavItem = { to: string; label: string; icon: typeof TerminalSquareIcon }
type WorkspaceNavGroup = { id: string; label: string; items: WorkspaceNavItem[] }

function WorkspaceNav({ nav }: { nav: WorkspaceNavGroup[] }) {
  const { setOpenMobile } = useSidebar()
  return nav.map(({ id, label, items }) => <SidebarGroup key={id}>
    <SidebarGroupLabel>{label}</SidebarGroupLabel>
    <SidebarGroupContent>
      <SidebarMenu>{items.map(({ to, label: itemLabel, icon: Icon }) => <SidebarMenuItem key={to}><SidebarMenuButton asChild tooltip={itemLabel}><NavLink to={to} onClick={() => setOpenMobile(false)} className={({ isActive }) => isActive ? 'font-medium' : ''}><Icon /><span>{itemLabel}</span></NavLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>)
}

function WorkspaceRoutes({ executor, token }: { executor: boolean; token: AuthMiniApi }) {
  return <Routes><Route path="/console" element={executor ? <Navigate to="/resources" replace /> : null} /><Route path="/history-records" element={executor ? <Navigate to="/resources" replace /> : <HistoryRecordsPage token={token} />} /><Route path="/insights" element={executor ? <Navigate to="/resources" replace /> : <InsightsPage token={token} />} /><Route path="/reasoning-audit" element={executor ? <Navigate to="/resources" replace /> : <ReasoningAuditPage token={token} />} /><Route path="/threads" element={executor ? <Navigate to="/resources" replace /> : <ThreadsPage token={token} />} /><Route path="/threads/:id" element={executor ? <Navigate to="/resources" replace /> : <ThreadDetailPage token={token} />} /><Route path="/browser" element={executor ? <Navigate to="/resources" replace /> : <BrowserPage token={token} />} /><Route path="/file-objects" element={executor ? <Navigate to="/resources" replace /> : <FileObjectsPage token={token} />} /><Route path="/gallery" element={executor ? <Navigate to="/resources" replace /> : <GalleryPage token={token} />} /><Route path="/machines" element={<Machines token={token} />} /><Route path="/commands" element={<CommandsPage token={token} />} /><Route path="/resources" element={<ResourcesPage token={token} />} /><Route path="/tools" element={<ToolCatalogPage token={token} />} /><Route path="/skills" element={<SkillsPage token={token} />} /><Route path="/settings" element={<SettingsPage token={token} />} /><Route path="*" element={<Navigate to={executor ? "/resources" : "/console"} replace />} /></Routes>
}

function AppHeader({ language, threads, tasksLoading, tasksError }: { language: Language; threads: Subthread[]; tasksLoading: boolean; tasksError: boolean }) {
  const { t } = useUi()
  return <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger><PanelLeftIcon /></SidebarTrigger><div className="ml-auto"><DropdownMenu><DropdownMenuTrigger asChild><Button aria-label={`${t('activeTasks')}: ${threads.length}`} className="relative size-11" variant="ghost" size="icon"><ActivityIcon /><Badge className="absolute -right-1 -top-1 min-w-5 justify-center px-1" variant="secondary">{threads.length}</Badge><span className="sr-only">{t('activeTasks')}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-2rem))]"><DropdownMenuLabel>{t('activeTasks')}</DropdownMenuLabel>{tasksLoading ? <div className="px-2 py-2 text-sm text-muted-foreground">{t('activeTasksLoading')}</div> : tasksError ? <div className="px-2 py-2 text-sm text-destructive">{t('activeTasksError')}</div> : threads.length === 0 ? <div className="px-2 py-2 text-sm text-muted-foreground">{t('noActiveTasks')}</div> : threads.map((thread) => <DropdownMenuItem asChild key={thread.id}><Link className="flex min-w-0 flex-col items-start gap-1" to={`/threads/${thread.id}`}><span className="flex w-full items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span><Badge className="shrink-0" variant="outline">{threadStatusLabel(t, thread.status)}</Badge></span><span className="w-full truncate text-xs text-muted-foreground">{thread.task}</span></Link></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div><AuthMiniButton lang={language} size="sm" variant="ghost" /></header>
}

function Workspace() {
  const { sdk } = useAuthMini()
  if (!sdk) return null
  const token = sdk
  const { dark, language, setLanguage, toggleTheme, t } = useUi()
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status', token) })
  const workNav = [{ to: '/console', label: t('console'), icon: TerminalSquareIcon }, { to: '/threads', label: goalText(language, 'goals'), icon: GitForkIcon }, { to: '/browser', label: t('browser'), icon: Globe2Icon }]
  const auditNav = [{ to: '/insights', label: t('insights'), icon: ActivityIcon }, { to: '/history-records', label: t('historyRecords'), icon: DatabaseIcon }, { to: '/reasoning-audit', label: t('reasoningAudit'), icon: ActivityIcon }, { to: '/commands', label: t('commands'), icon: TerminalSquareIcon }, { to: '/file-objects', label: t('fileObjects'), icon: FileIcon }, { to: '/gallery', label: t('gallery'), icon: ImageIcon }]
  const systemNav = [{ to: '/machines', label: t('machines'), icon: NetworkIcon }, { to: '/resources', label: t('resources'), icon: ActivityIcon }]
  const configurationNav = [{ to: '/tools', label: t('tools'), icon: WrenchIcon }, { to: '/skills', label: t('skills'), icon: BookOpenIcon }, { to: '/settings', label: t('settings'), icon: Settings2Icon }]
  const nav: WorkspaceNavGroup[] = status.data?.deployment_role === 'executor'
    ? [{ id: 'audit', label: t('navAudit'), items: [{ to: '/commands', label: t('commands'), icon: TerminalSquareIcon }] }, { id: 'system', label: t('navSystem'), items: systemNav }, { id: 'configuration', label: t('navConfiguration'), items: configurationNav }]
    : [{ id: 'work', label: t('navWork'), items: workNav }, { id: 'audit', label: t('navAudit'), items: auditNav }, { id: 'system', label: t('navSystem'), items: systemNav }, { id: 'configuration', label: t('navConfiguration'), items: configurationNav }]
  const executor = status.data?.deployment_role === 'executor'
  const activeThreads = useQuery({ queryKey: ['threads', 'active'], queryFn: () => api<ThreadIndex>('/api/threads?status=active', token), refetchInterval: 1000, enabled: status.data?.deployment_role === 'controller' })
  return <SidebarProvider><Sidebar><SidebarHeader><div className="flex items-center gap-2.5 px-2 py-1 font-heading text-lg font-semibold"><img alt="" aria-hidden="true" className="size-6 shrink-0" src="/cybion-mark.svg" />Cybion</div></SidebarHeader><SidebarContent><WorkspaceNav nav={nav} /></SidebarContent><SidebarFooter><DropdownMenu><DropdownMenuTrigger asChild><Button className="self-center" variant="ghost" size="icon-sm"><LanguagesIcon /><span className="sr-only">{t('language')}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={language} onValueChange={(value) => setLanguage(value as Language)}><DropdownMenuRadioItem value="zh">中文</DropdownMenuRadioItem><DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><Button variant="ghost" size="sm" onClick={toggleTheme}><MonitorCogIcon data-icon="inline-start" />{dark ? t('light') : t('dark')}</Button></SidebarFooter></Sidebar><SidebarInset className="h-svh overflow-hidden"><AppHeader language={language} threads={activeThreads.data?.subthreads ?? []} tasksLoading={activeThreads.isLoading} tasksError={activeThreads.isError} />{executor ? <div className="min-h-0 flex-1 overflow-y-auto"><WorkspaceRoutes executor token={token} /></div> : <Console token={token} threadsQuery={activeThreads}><WorkspaceRoutes executor={false} token={token} /></Console>}</SidebarInset></SidebarProvider>
}

function formatTimestamp(language: Language, value: string) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value))
}
function formatBytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}` }
function contextWindowLimitLabel(t: (key: TranslationKey) => string, limit: number | null) { return limit === null ? t('contextWindowUnlimited') : t('contextWindowTokens').replace('{tokens}', new Intl.NumberFormat().format(limit)) }

function threadStatusLabel(t: (key: TranslationKey) => string, status: Subthread['status']) {
  return t(status === 'queued' ? 'threadQueued' : status === 'retrying' ? 'threadRetrying' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'commandCancelled' : status === 'failed' ? 'requestFailed' : 'threadRunning')
}

function goalStateLabel(language: Language, state: GoalState) { return goalText(language, state) }

function mainThreadStatusLabel(t: (key: TranslationKey) => string, status: MainThreadSummary['status']) {
  return t(status === 'running' ? 'threadRunning' : status === 'retrying' ? 'threadRetrying' : 'threadIdle')
}

function subthreadConversationItems(thread: Subthread, events: AgentEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [{ kind: 'message', id: `${thread.id}-task`, message: { role: 'user', content: `## Objective\n${thread.task}\n\n## Done when\n${thread.completion_criteria}`, created_at: thread.created_at }, queued: thread.goal_state === 'active' && thread.status === 'queued' }]
  events.forEach((event) => {
    if (event.type === 'tool_call') items.push({ kind: 'tool', id: `${thread.id}-${event.call_id}`, call_id: event.call_id, name: event.name, arguments: event.arguments, complete: false, started_at: event.started_at })
    if (event.type === 'tool_result') {
      const tool = [...items].reverse().find((item): item is Extract<ConversationItem, { kind: 'tool' }> => item.kind === 'tool' && item.call_id === event.call_id)
      if (tool) Object.assign(tool, { complete: true, finished_at: event.finished_at, added_lines: event.added_lines, deleted_lines: event.deleted_lines })
    }
    if (event.type === 'complete') items.push({ kind: 'message', id: `${thread.id}-${crypto.randomUUID()}`, message: event.message, queued: false })
  })
  return items
}

function ThreadsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const title = goalText(language, 'goals')
  const description = goalText(language, 'description')
  const [searchParams, setSearchParams] = useSearchParams()
  const statusValue = searchParams.get('status')
  const status: GoalThreadStatus = ['active', 'all', 'terminal', 'completed', 'blocked', 'cancelled'].includes(statusValue ?? 'active') ? (statusValue ?? 'active') as GoalThreadStatus : 'active'
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
  const pageSize = [20, 50, 100].includes(Number(searchParams.get('page_size'))) ? Number(searchParams.get('page_size')) : 20
  const keyword = searchParams.get('query') ?? ''
  const model = searchParams.get('model') ?? ''
  const [draftKeyword, setDraftKeyword] = useState(keyword)
  const filterKey = searchParams.toString()
  const queryClient = useQueryClient()
  const activeSignatureRef = useRef<string | null>(null)
  useEffect(() => { setDraftKeyword(keyword) }, [filterKey])
  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key))
    setSearchParams(next)
  }
  const liveActive = status === 'active' && !keyword && !model && !searchParams.has('page') && !searchParams.has('page_size')
  const activeIndex = useQuery({ queryKey: ['threads', 'active'], queryFn: () => api<ThreadIndex>('/api/threads?status=active', token), refetchInterval: liveActive ? 1000 : false })
  const query = new URLSearchParams({ status, page: String(page), page_size: String(pageSize) })
  if (keyword) query.set('query', keyword)
  if (model) query.set('model', model)
  const filtered = useQuery({ queryKey: ['goal-threads', query.toString()], enabled: !liveActive, queryFn: () => api<ThreadIndex>(`/api/threads?${query}`, token) })
  const data = liveActive ? activeIndex.data : filtered.data
  const queryError = liveActive ? activeIndex.error : filtered.error
  const fetching = liveActive ? activeIndex.isFetching : filtered.isFetching
  const activeSignature = (activeIndex.data?.subthreads ?? []).map((thread) => `${thread.id}:${thread.goal_state}:${thread.updated_at}`).sort().join(',')
  useEffect(() => {
    if (activeSignatureRef.current !== null && activeSignatureRef.current !== activeSignature) void queryClient.invalidateQueries({ queryKey: ['goal-threads'] })
    activeSignatureRef.current = activeSignature
  }, [activeSignature, queryClient])
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  const rangeStart = data?.total ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = data ? rangeStart + data.subthreads.length - 1 : 0
  const range = t('threadRange').replace('{from}', String(rangeStart)).replace('{to}', String(rangeEnd)).replace('{total}', String(data?.total ?? 0))
  const models = data?.models ?? activeIndex.data?.models ?? []
  const statusLabel = (value: GoalThreadStatus) => value === 'active' ? goalText(language, 'active') : value === 'all' ? t('threadAll') : value === 'terminal' ? t('terminalAll') : value === 'completed' ? goalText(language, 'achieved') : goalText(language, value)
  const updateStatus = (value: GoalThreadStatus) => setParams({ status: value, page: '1' })
  const applySearch = (event: FormEvent) => { event.preventDefault(); setParams({ page: '1', query: draftKeyword.trim() || null }) }
  const clearFilters = () => { setDraftKeyword(''); setSearchParams({ status: 'active' }) }
  useEffect(() => { if (!liveActive && page > totalPages) setParams({ page: String(totalPages) }) }, [liveActive, page, totalPages])
  if (queryError) return <Page title={title} description={description}><ErrorAlert error={message(queryError)} /></Page>
  return <Page title={title} description={description}>
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent className="grid gap-4"><form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_11rem_13rem_auto]" onSubmit={applySearch}><InputGroup><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput aria-label={t('threadSearch')} value={draftKeyword} onChange={(event) => setDraftKeyword(event.target.value)} placeholder={t('threadSearchPlaceholder')} /><InputGroupAddon align="inline-end"><InputGroupButton type="submit"><SearchIcon /></InputGroupButton></InputGroupAddon></InputGroup><Select value={status} onValueChange={(value) => updateStatus(value as GoalThreadStatus)}><SelectTrigger aria-label={t('threadStatusFilter')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">{statusLabel('active')}</SelectItem><SelectItem value="all">{statusLabel('all')}</SelectItem><SelectItem value="terminal">{statusLabel('terminal')}</SelectItem><SelectItem value="completed">{statusLabel('completed')}</SelectItem><SelectItem value="blocked">{statusLabel('blocked')}</SelectItem><SelectItem value="cancelled">{statusLabel('cancelled')}</SelectItem></SelectContent></Select><Select value={model || 'all'} onValueChange={(value) => setParams({ page: '1', model: value === 'all' ? null : value })}><SelectTrigger aria-label={t('threadModelFilter')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('threadAllModels')}</SelectItem>{models.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" onClick={clearFilters}><XIcon data-icon="inline-start" />{t('threadClearFilters')}</Button></form><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><Badge variant={liveActive ? 'secondary' : 'outline'}>{statusLabel(status)}</Badge>{(keyword || model) && <span className="text-sm text-muted-foreground">{t('threadFiltersApplied')}</span>}</div>{!liveActive && <div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{t('threadPageSize')}</span><Select value={String(pageSize)} onValueChange={(value) => setParams({ page: '1', page_size: value })}><SelectTrigger aria-label={t('threadPageSize')} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent></Select>{fetching && <Spinner />}</div>}</div>{!data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div> : data.subthreads.length === 0 && !liveActive ? <p className="text-sm text-muted-foreground">{t('threadNoMatches')}</p> : <Table><TableHeader><TableRow><TableHead>{goalText(language, 'goal')}</TableHead><TableHead>{goalText(language, 'state')}</TableHead><TableHead>{goalText(language, 'execution')}</TableHead><TableHead>{t('threadModel')}</TableHead><TableHead>{t('threadUpdated')}</TableHead></TableRow></TableHeader><TableBody>{liveActive && <TableRow><TableCell><Button asChild className="h-auto p-0" variant="link"><Link to="/console">{t('mainThread')}</Link></Button><p className="max-w-md truncate text-xs text-muted-foreground">{t('mainThreadDescription')}</p></TableCell><TableCell>—</TableCell><TableCell><Badge variant={data.main_thread.status === 'running' ? 'secondary' : 'outline'}>{mainThreadStatusLabel(t, data.main_thread.status)}</Badge></TableCell><TableCell><code>{data.main_thread.model}</code></TableCell><TableCell>{data.main_thread.updated_at ? formatTimestamp(language, data.main_thread.updated_at) : '—'}</TableCell></TableRow>}{data.subthreads.map((thread) => <ThreadRow key={thread.id} language={language} t={t} thread={thread} />)}{liveActive && data.subthreads.length === 0 && <TableRow><TableCell className="text-sm text-muted-foreground" colSpan={5}>{t('noActiveThreads')}</TableCell></TableRow>}</TableBody></Table>}{!liveActive && data && <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{range}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}><ChevronLeftIcon data-icon="inline-start" />{t('threadPreviousPage')}</Button><Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setParams({ page: String(page + 1) })}>{t('threadNextPage')}<ChevronRightIcon data-icon="inline-end" /></Button></div></div>}</CardContent>
    </Card>
  </Page>
}

function ThreadRow({ thread, language, t }: { thread: Subthread; language: Language; t: (key: TranslationKey) => string }) {
  return <TableRow><TableCell><Button asChild className="h-auto p-0" variant="link"><Link to={`/threads/${thread.id}`}>{thread.title}</Link></Button><p className="max-w-md truncate text-xs text-muted-foreground" title={thread.task}>{thread.task}</p></TableCell><TableCell><Badge variant={thread.goal_state === 'active' ? 'secondary' : 'outline'}>{goalStateLabel(language, thread.goal_state)}</Badge></TableCell><TableCell><Badge variant={thread.status === 'running' ? 'secondary' : 'outline'}>{threadStatusLabel(t, thread.status)}</Badge></TableCell><TableCell><code>{thread.model}</code></TableCell><TableCell>{formatTimestamp(language, thread.updated_at)}</TableCell></TableRow>
}

function ThreadDetailPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const { id = '' } = useParams()
  const query = useQuery({ queryKey: ['thread', id], queryFn: () => api<SubthreadDetail>(`/api/threads/${id}`, token), enabled: Boolean(id), retry: false })
  const title = goalText(language, 'goals')
  const description = goalText(language, 'description')
  if (query.error) return <Page title={title} description={description}><ErrorAlert error={message(query.error)} /></Page>
  if (!query.data) return <Page title={title} description={description}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  const { thread } = query.data
  return <main className="flex h-full min-h-0 flex-col"><div className="shrink-0 flex flex-wrap items-center gap-2 border-b px-4 py-3"><Button asChild variant="outline" size="sm"><Link to="/threads"><ArrowLeftIcon data-icon="inline-start" />{goalText(language, 'back')}</Link></Button><div className="min-w-0"><h1 className="truncate font-heading text-lg font-semibold">{thread.title}</h1><p className="text-sm text-muted-foreground">{goalText(language, 'goal')}</p></div><Badge className="ml-auto" variant={thread.goal_state === 'active' ? 'secondary' : 'outline'}>{goalStateLabel(language, thread.goal_state)}</Badge><Badge variant="outline">{threadStatusLabel(t, thread.status)}</Badge><Badge variant="outline">{thread.model}</Badge><Badge variant="outline">{contextWindowLimitLabel(t, thread.context_window_limit)}</Badge></div><div className="max-h-[35svh] shrink-0 overflow-y-auto border-b p-4"><dl className="mx-auto grid w-full max-w-4xl gap-3 text-sm"><div><dt className="font-medium">{goalText(language, 'objective')}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{thread.task}</dd></div><div><dt className="font-medium">{goalText(language, 'doneWhen')}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{thread.completion_criteria}</dd></div>{thread.goal_evidence && <div><dt className="font-medium">{goalText(language, 'evidence')}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{thread.goal_evidence}</dd></div>}{thread.blocked_reason && <div><dt className="font-medium">{goalText(language, 'blocker')}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{thread.blocked_reason}</dd></div>}{thread.result && <div><dt className="font-medium">{goalText(language, 'outcome')}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{thread.result}</dd></div>}</dl></div><div className="shrink-0 border-b px-4 py-2"><p className="mx-auto w-full max-w-4xl text-sm font-medium">{goalText(language, 'history')}</p></div><div className="min-h-0 flex-1"><ThreadHistoryRecordsView threadId={thread.id} /></div></main>
}


function protocolMessageText(payload: Record<string, unknown>) {
  const content = payload.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const value = part as Record<string, unknown>
    return value.type === 'output_text' && typeof value.text === 'string' ? [value.text] : []
  }).join('')
}

function parsedToolOutput(output: string | undefined): Record<string, unknown> | undefined {
  if (!output) return undefined
  try {
    const value: unknown = JSON.parse(output)
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

function stringValue(value: unknown) { return typeof value === 'string' ? value : '' }

function safeReasoningSummary(payload: Record<string, unknown>) {
  const summary = payload.summary
  if (!Array.isArray(summary)) return ''
  return summary.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const text = (item as Record<string, unknown>).text
    return typeof text === 'string' ? [text] : []
  }).join('\n')
}

function threadHistoryItems(records: ThreadHistoryRecord[], subthreads: SubthreadReference[]): ConversationItem[] {
  const items: ConversationItem[] = []
  const calls = new Map<string, Extract<ConversationItem, { kind: 'tool' }>>()
  const subthreadById = new Map(subthreads.map((thread) => [thread.id, thread]))
  const subthreadByForkRecordId = new Map(subthreads.map((thread) => [thread.from_record_id, thread]))
  for (const record of records) {
    const type = stringValue(record.payload.type)
    const role = stringValue(record.payload.role)
    if (record.kind === 'input' && (role === 'user' || role === 'assistant')) {
      items.push({ kind: 'message', id: String(record.id), message: { id: record.id, role, content: stringValue(record.payload.content), created_at: record.created_at }, queued: false })
      continue
    }
    if (record.kind === 'response_output' && type === 'message') {
      items.push({ kind: 'message', id: String(record.id), message: { id: record.id, role: role || 'assistant', content: protocolMessageText(record.payload), images: record.images, created_at: record.created_at }, queued: false })
      continue
    }
    if (record.kind === 'response_output' && type === 'reasoning') {
      items.push({ kind: 'reasoning', id: String(record.id), summary: safeReasoningSummary(record.payload) })
      continue
    }
    if (record.kind === 'response_output' && (type === 'function_call' || type === 'computer_call')) {
      const callId = stringValue(record.payload.call_id) || String(record.id)
      const argumentsText = stringValue(record.payload.arguments) || '{}'
      const arguments_ = parsedToolOutput(argumentsText) ?? {}
      const name = stringValue(record.payload.name) || type
      const subthreadId = stringValue(arguments_.id)
      const subthreadAction = name === 'fork_subthread' ? 'fork' : name === 'cancel_subthread' ? 'cancel' : name === 'retry_subthread' ? 'retry' : undefined
      const tool: Extract<ConversationItem, { kind: 'tool' }> = { kind: 'tool', id: String(record.id), call_id: callId, name, arguments: arguments_, complete: false, started_at: record.created_at, subthread: subthreadId ? subthreadById.get(subthreadId) : subthreadAction === 'fork' ? subthreadByForkRecordId.get(record.id) : undefined, subthreadAction }
      calls.set(callId, tool)
      items.push(tool)
      continue
    }
    if (record.kind === 'tool_output' && type === 'function_call_output') {
      const callId = stringValue(record.payload.call_id)
      const output = stringValue(record.payload.output)
      const outputPayload = parsedToolOutput(output)
      if (outputPayload?.type === 'subthread_handoff') {
        const subthreadId = stringValue(outputPayload.subthread_id)
        items.push({ kind: 'handoff', id: String(record.id), subthreadId, terminalState: stringValue(outputPayload.terminal_state), result: stringValue(outputPayload.terminal_result), detail: stringValue(outputPayload.terminal_detail), subthread: subthreadById.get(subthreadId) })
        continue
      }
      const call = calls.get(callId)
      items.push({ kind: 'tool', id: String(record.id), call_id: callId || String(record.id), name: call?.name ?? type, arguments: call?.arguments ?? {}, complete: true, output, started_at: call?.started_at, finished_at: record.created_at, subthread: call?.subthread, subthreadAction: call?.subthreadAction })
      continue
    }
    items.push({ kind: 'fallback', id: String(record.id), label: record.kind === 'checkpoint' ? 'checkpoint' : type || record.kind })
  }
  return items
}

function ThreadHistoryRecordsView({ threadId, focusRecordId, onResend, resendingMessageId, refreshKey = 0 }: { threadId: string | null; focusRecordId?: number; onResend?: (message: ChatMessage) => void; resendingMessageId?: number | null; refreshKey?: number }) {
  const token = useAuthToken()
  const { t } = useUi()
  const [records, setRecords] = useState<ThreadHistoryRecord[]>([])
  const [subthreads, setSubthreads] = useState<SubthreadReference[]>([])
  const [cursor, setCursor] = useState(0)
  const [before, setBefore] = useState<number | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [active, setActive] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [error, setError] = useState('')
  const request = async (params: URLSearchParams) => api<ThreadHistoryPage>(`/api/thread-history?${params}`, token)
  const reset = async () => {
    setLoading(true); setError(''); setBefore(undefined)
    try {
      const params = new URLSearchParams(); if (threadId) params.set('thread_id', threadId)
      const page = await request(params)
      setRecords(page.records); setSubthreads(page.subthreads); setCursor(page.next_after_id); setHasMore(page.has_more); setActive(page.active)
    } catch (cause) { setError(message(cause)) } finally { setLoading(false) }
  }
  useEffect(() => { void reset() }, [threadId, refreshKey])
  useEffect(() => {
    if (!active) return
    const interval = window.setInterval(() => { void (async () => {
      try {
        const params = new URLSearchParams({ after_id: String(cursor) }); if (threadId) params.set('thread_id', threadId)
        const page = await request(params)
        if (page.records.length) setRecords((current) => {
          const known = new Set(current.map((record) => record.id)); return [...current, ...page.records.filter((record) => !known.has(record.id))]
        })
        if (page.subthreads.length) setSubthreads((current) => { const byId = new Map(current.map((thread) => [thread.id, thread])); page.subthreads.forEach((thread) => byId.set(thread.id, thread)); return [...byId.values()] })
        setCursor(page.next_after_id); setActive(page.active)
      } catch (cause) { setError(message(cause)) }
    })() }, 1000)
    return () => window.clearInterval(interval)
  }, [active, cursor, threadId])
  useEffect(() => { if (focusRecordId !== undefined) document.getElementById(`history-entry-${focusRecordId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [focusRecordId, records])
  const loadEarlier = async () => {
    const oldest = records[0]?.id; if (!oldest || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const params = new URLSearchParams({ before_id: String(oldest) }); if (threadId) params.set('thread_id', threadId)
      const page = await request(params)
      setRecords((current) => [...page.records, ...current]); if (page.subthreads.length) setSubthreads((current) => { const byId = new Map(current.map((thread) => [thread.id, thread])); page.subthreads.forEach((thread) => byId.set(thread.id, thread)); return [...byId.values()] }); setHasMore(page.has_more); setBefore(page.next_before_id)
    } catch (cause) { setError(message(cause)) } finally { setLoadingEarlier(false) }
  }
  if (loading) return <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div>
  if (error) return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3"><ErrorAlert error={error} /></div>
  return <div className="min-h-0 flex-1"><ConversationFeed items={threadHistoryItems(records, subthreads)} running={active} hasMore={hasMore || Boolean(before)} loadingEarlier={loadingEarlier} onLoadEarlier={() => void loadEarlier()} onResend={onResend} resendingMessageId={resendingMessageId} /></div>
}

function ConversationFeed({ items, running = false, hasMore = false, loadingEarlier = false, onLoadEarlier, onResend, resendingMessageId }: { items: ConversationItem[]; running?: boolean; hasMore?: boolean; loadingEarlier?: boolean; onLoadEarlier?: () => void; onResend?: (message: ChatMessage) => void; resendingMessageId?: number | null }) {
  const token = useAuthToken()
  const { t } = useUi()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) })
  const [now, setNow] = useState(() => Date.now())
  const hasRunningTool = items.some((item) => item.kind === 'tool' && !item.complete && item.started_at)
  useEffect(() => {
    if (!hasRunningTool) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [hasRunningTool])
  return <MessageScrollerProvider autoScroll defaultScrollPosition="end"><MessageScroller className="flex-1"><MessageScrollerViewport><MessageScrollerContent className="mx-auto w-full max-w-4xl p-4">{hasMore && onLoadEarlier && <MessageScrollerItem className="flex justify-center [content-visibility:auto] [contain-intrinsic-size:3rem]"><Button size="sm" variant="outline" disabled={loadingEarlier} onClick={onLoadEarlier}>{loadingEarlier && <Spinner data-icon="inline-start" />}{loadingEarlier ? t('loadingEarlierMessages') : t('loadEarlierMessages')}</Button></MessageScrollerItem>}{items.map((item) => <MessageScrollerItem id={item.kind === 'message' && item.message.id !== undefined ? `history-entry-${item.message.id}` : undefined} key={item.id} className="[content-visibility:auto] [contain-intrinsic-size:6rem]"><ConversationEntry item={item} now={now} peers={peers.data ?? []} onResend={onResend} resendingMessageId={resendingMessageId} /></MessageScrollerItem>)}{running && <MessageScrollerItem className="[content-visibility:auto] [contain-intrinsic-size:3rem]"><ThreadRunning /></MessageScrollerItem>}</MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton behavior="auto" /></MessageScroller></MessageScrollerProvider>
}

function ThreadRunning() {
  const { t } = useUi()
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /><Badge variant="secondary">{t('threadRunning')}</Badge><span>{t('agentWorking')}</span></div>
}


function VoicePreviewPanel({ preview, onContinue, onDiscard, onSend }: { preview: VoicePreview; onContinue: () => void; onDiscard: () => void; onSend: () => void }) {
  const { t } = useUi()
  const label = preview.state === 'listening'
    ? t('voiceListening')
    : preview.state === 'transcribing' || preview.state === 'deciding'
      ? t('voiceUnderstanding')
      : preview.state === 'confirm'
        ? t('voiceConfirm')
        : preview.transcript ? t('voiceContinue') : t('voiceReady')
  return <div aria-live="polite" className="mx-auto mb-2 flex max-w-4xl items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm"><MicIcon className="mt-0.5 size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><Badge variant={preview.state === 'confirm' ? 'secondary' : 'outline'}>{label}</Badge>{preview.transcript && <p className="mt-1.5 whitespace-pre-wrap break-words text-foreground">{preview.transcript}</p>}</div>{preview.state === 'confirm' && <div className="flex shrink-0 flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" onClick={onDiscard}>{t('voiceDiscard')}</Button><Button type="button" size="sm" variant="outline" onClick={onContinue}>{t('voiceContinue')}</Button><Button type="button" size="sm" onClick={onSend}>{t('voiceSend')}</Button></div>}</div>
}

function Console({ children, token, threadsQuery }: { children: ReactNode; token: AuthMiniApi; threadsQuery: ReturnType<typeof useQuery<ThreadIndex>> }) {
  const { language, t } = useUi()
  const location = useLocation()
  const focus = new URLSearchParams(location.search).get('focus')
  const queryClient = useQueryClient()
  const activeRef = useRef(new Map<string, AbortController>())
  const recorderRef = useRef<MediaRecorder | null>(null)
  const continuousVoiceRef = useRef(false)
  const voiceTranscriptRef = useRef('')
  const voiceAwaitingConfirmationRef = useRef(false)
  const announceRef = useRef(localStorage.getItem('cybion.announce_replies') === 'true')
  const announcementRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const announcedMessageRef = useRef<number | null>(null)
  const focusedMessageRef = useRef<number | null>(null)
  const composingRef = useRef(false)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const attachmentPickerRef = useRef<HTMLInputElement>(null)
  const [activeStreams, setActiveStreams] = useState<string[]>([])
  const [resendingMessageId, setResendingMessageId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [continuousVoice, setContinuousVoice] = useState(continuousVoiceRef.current)
  const [voicePreview, setVoicePreview] = useState<VoicePreview>({ state: 'armed', transcript: '' })
  const [announceReplies, setAnnounceReplies] = useState(announceRef.current)
  const [attachments, setAttachments] = useState<StoredFile[]>([])
  const [uploadingAttachment, setUploadingAttachment] = useState(false)
  const activeSubthreads = threadsQuery.data?.subthreads ?? []

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

  const submitContent = (content: string, attached: StoredFile[] = []) => {
    if (resendingMessageId !== null) return
    const text = content.trim()
    if (!text && attached.length === 0) return
    const attachmentContext = attached.length ? `\n\nAttached file objects:\n${attached.map((file) => `- ${file.filename} (${file.mime_type}; SHA-256 ${file.id})`).join('\n')}` : ''
    setError('')
    void startAgentTurn(token, { role: 'user', content: `${text}${attachmentContext}`.trim() })
      .then(() => setHistoryRefresh((value) => value + 1))
      .catch((cause: unknown) => setError(message(cause)))
  }

  const resendMessage = (entry: ChatMessage) => {
    const recordId = entry.id
    if (recordId === undefined || resendingMessageId !== null) return
    setResendingMessageId(recordId)
    setError('')
    void resendAgentTurn(token, recordId)
      .then(() => setHistoryRefresh((value) => value + 1))
      .catch((cause: unknown) => setError(message(cause)))
      .finally(() => setResendingMessageId(null))
  }

  const attachFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setUploadingAttachment(true)
    setError('')
    try {
      const uploaded = [] as StoredFile[]
      for (const file of Array.from(files)) uploaded.push(await uploadStoredFile(token, file))
      setAttachments((current) => [...current, ...uploaded.filter((file) => !current.some((existing) => existing.id === file.id))])
      await queryClient.invalidateQueries({ queryKey: ['file-objects'] })
    } catch (cause) { setError(message(cause)) } finally { setUploadingAttachment(false) }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = draftRef.current
    if (!input) return
    const content = input.value
    input.value = ''
    submitContent(content, attachments)
    setAttachments([])
  }

  const stopAll = async () => {
    await api('/api/agent/turn', token, { method: 'DELETE' }).catch(() => undefined)
    setHistoryRefresh((value) => value + 1)
  }

  const voiceContext = () => ({ latest_user_message: '', latest_assistant_message: '' })

  const startRecording = async () => {
    if (recorderRef.current || voiceAwaitingConfirmationRef.current) return
    let stream: MediaStream | null = null
    try {
      if (typeof MediaRecorder.isTypeSupported !== 'function') throw new Error('This browser does not support WebM/Opus audio recording.')
      const mimeType = requireWebmOpusMimeType(MediaRecorder.isTypeSupported.bind(MediaRecorder))
      const recordingStream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } })
      stream = recordingStream
      const recorder = new MediaRecorder(recordingStream, { mimeType })
      const chunks: Blob[] = []
      let frame = 0
      let audioContext: AudioContext | null = null
      let heardSpeech = false
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
      recorder.onstop = () => {
        if (recorderRef.current === recorder) recorderRef.current = null
        if (frame) cancelAnimationFrame(frame)
        void audioContext?.close()
        recordingStream.getTracks().forEach((track) => track.stop())
        setRecording(false)
        const audio = new Blob(chunks, { type: recorder.mimeType })
        if (!audio.size || (continuousVoiceRef.current && !heardSpeech)) {
          if (continuousVoiceRef.current && !voiceAwaitingConfirmationRef.current) {
            setVoicePreview({ state: 'armed', transcript: voiceTranscriptRef.current })
            void startRecording()
          }
          return
        }
        setTranscribing(true)
        if (continuousVoiceRef.current) setVoicePreview({ state: 'transcribing', transcript: voiceTranscriptRef.current })
        void transcribeAudio(token, audio).then(async ({ text }) => {
          if (!continuousVoiceRef.current) {
            if (draftRef.current) draftRef.current.value = text
            return
          }
          const transcript = [voiceTranscriptRef.current, text.trim()].filter(Boolean).join(' ').trim()
          if (!transcript) return
          voiceTranscriptRef.current = transcript
          setVoicePreview({ state: 'deciding', transcript })
          const decision = await decideVoiceTurn(token, { transcript, ...voiceContext() })
          if (!continuousVoiceRef.current) return
          if (decision.action === 'submit') {
            voiceTranscriptRef.current = ''
            setVoicePreview({ state: 'armed', transcript: '' })
            submitContent(transcript)
            return
          }
          if (decision.action === 'discard') {
            voiceTranscriptRef.current = ''
            setVoicePreview({ state: 'armed', transcript: '' })
            return
          }
          if (decision.action === 'confirm') {
            voiceAwaitingConfirmationRef.current = true
            setVoicePreview({ state: 'confirm', transcript })
            return
          }
          setVoicePreview({ state: 'armed', transcript })
        }).catch((cause: unknown) => {
          if (continuousVoiceRef.current) {
            voiceAwaitingConfirmationRef.current = true
            setVoicePreview({ state: 'confirm', transcript: voiceTranscriptRef.current })
          }
          setError(message(cause))
        }).finally(() => {
          setTranscribing(false)
          if (continuousVoiceRef.current && !voiceAwaitingConfirmationRef.current) void startRecording()
        })
      }
      recorderRef.current = recorder
      recorder.start()
      setError('')
      setRecording(true)
      if (continuousVoiceRef.current) {
        setVoicePreview({ state: 'armed', transcript: voiceTranscriptRef.current })
        audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        audioContext.createMediaStreamSource(recordingStream).connect(analyser)
        const samples = new Uint8Array(analyser.fftSize)
        const started = performance.now()
        let noiseFloor = 0
        let noiseSamples = 0
        let speechStartedAt = 0
        let lastSpeech = started
        const detectSilence = () => {
          if (recorder.state === 'inactive') return
          analyser.getByteTimeDomainData(samples)
          const energy = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length)
          const now = performance.now()
          if (!heardSpeech && now - started < 600) {
            noiseFloor = (noiseFloor * noiseSamples + energy) / (noiseSamples + 1)
            noiseSamples += 1
          }
          const speechThreshold = Math.max(0.018, noiseFloor * 3.2)
          if (energy >= speechThreshold) {
            if (!speechStartedAt) speechStartedAt = now
            if (now - speechStartedAt >= 280) {
              if (!heardSpeech) setVoicePreview({ state: 'listening', transcript: voiceTranscriptRef.current })
              heardSpeech = true
              lastSpeech = now
            }
          } else {
            speechStartedAt = 0
          }
          if ((heardSpeech && now - lastSpeech > 2000) || (!heardSpeech && now - started > 30000)) recorder.stop()
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
    if (enabled) {
      voiceAwaitingConfirmationRef.current = false
      setVoicePreview({ state: 'armed', transcript: voiceTranscriptRef.current })
      void startRecording()
    } else {
      voiceAwaitingConfirmationRef.current = false
      voiceTranscriptRef.current = ''
      setVoicePreview({ state: 'armed', transcript: '' })
      if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
    }
  }

  const continueVoiceTurn = () => {
    voiceAwaitingConfirmationRef.current = false
    setVoicePreview({ state: 'armed', transcript: voiceTranscriptRef.current })
    void startRecording()
  }

  const discardVoiceTurn = () => {
    voiceTranscriptRef.current = ''
    voiceAwaitingConfirmationRef.current = false
    setVoicePreview({ state: 'armed', transcript: '' })
    void startRecording()
  }

  const sendVoiceTurn = () => {
    const transcript = voiceTranscriptRef.current
    voiceTranscriptRef.current = ''
    voiceAwaitingConfirmationRef.current = false
    setVoicePreview({ state: 'armed', transcript: '' })
    if (transcript) submitContent(transcript)
    void startRecording()
  }

  const setAnnounce = (enabled: boolean) => {
    announceRef.current = enabled
    setAnnounceReplies(enabled)
    localStorage.setItem('cybion.announce_replies', enabled.toString())
    if (!enabled) stopAnnouncements()
  }

  const unavailable = resendingMessageId !== null
  const mainThreadRunning = threadsQuery.data?.main_thread.status === 'running' || threadsQuery.data?.main_thread.status === 'retrying'
  const consoleSurface = <main className="flex h-full flex-col"><div className="flex flex-wrap items-center gap-2 border-b px-4 py-3"><div><h1 className="font-heading text-lg font-semibold">{t('console')}</h1><p className="text-sm text-muted-foreground">{t('consoleDescription')}</p></div><div className="ml-auto" />{mainThreadRunning && <Button variant="destructive" size="sm" onClick={() => void stopAll()}><CircleStopIcon data-icon="inline-start" />{t('stop')}</Button>}</div><ThreadHistoryRecordsView threadId={null} focusRecordId={focus ? Number(focus) : undefined} onResend={resendMessage} resendingMessageId={resendingMessageId} refreshKey={historyRefresh} /></main>
  return <>
    <div className="min-h-0 flex-1 overflow-y-auto">{location.pathname === '/console' ? consoleSurface : children}</div>
    {error && <div className="shrink-0 px-4 pt-2"><ErrorAlert error={error} /></div>}
    <form className="shrink-0 border-t p-3" onSubmit={submit}>
      {continuousVoice && <VoicePreviewPanel preview={voicePreview} onContinue={continueVoiceTurn} onDiscard={discardVoiceTurn} onSend={sendVoiceTurn} />}
      <input ref={attachmentPickerRef} className="sr-only" type="file" multiple onChange={(event) => { void attachFiles(event.target.files); event.currentTarget.value = '' }} />
      {attachments.length > 0 && <div className="mx-auto mb-2 flex max-w-4xl flex-wrap gap-2">{attachments.map((file) => <Badge key={file.id} variant="secondary" className="max-w-full gap-1.5 py-1 pl-2"><PaperclipIcon className="size-3 shrink-0" /><span className="truncate">{file.filename}</span><button aria-label={`${t('removeAttachment')}: ${file.filename}`} className="rounded-sm p-0.5 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" type="button" onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}><XIcon className="size-3" /></button></Badge>)}</div>}
      <InputGroup className="mx-auto max-w-4xl">
        <InputGroupTextarea ref={draftRef} disabled={unavailable || uploadingAttachment} onCompositionStart={() => { composingRef.current = true }} onCompositionEnd={() => { composingRef.current = false }} onKeyDown={(event) => { if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return; event.preventDefault(); event.currentTarget.form?.requestSubmit() }} placeholder={t('outcomePlaceholder')} rows={2} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label={t('attachment')} disabled={unavailable || uploadingAttachment} onClick={() => attachmentPickerRef.current?.click()} size="icon-sm" type="button" variant="ghost">{uploadingAttachment ? <Spinner /> : <PaperclipIcon />}</InputGroupButton>
          <InputGroupButton aria-label={recording ? t('stopRecording') : t('startRecording')} disabled={unavailable || transcribing} onClick={toggleRecording} size="icon-sm" variant={recording ? 'destructive' : 'ghost'}>{recording ? <SquareIcon /> : <MicIcon />}</InputGroupButton>
          <InputGroupButton disabled={unavailable || uploadingAttachment} type="submit" variant="default" size="icon-sm"><SendIcon /><span className="sr-only">{t('mainThread')}</span></InputGroupButton>
        </InputGroupAddon>
        <InputGroupAddon align="block-end" className="border-t flex-col items-start sm:flex-row sm:items-center">
          <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1">
            <Field className="w-auto gap-1.5" orientation="horizontal"><Switch id="continuous-voice" checked={continuousVoice} onCheckedChange={setContinuous} /><FieldLabel htmlFor="continuous-voice" className="gap-1.5 text-xs font-medium text-foreground"><MicIcon />{t('continuousVoice')}</FieldLabel></Field>
            <Field className="w-auto gap-1.5" orientation="horizontal"><Switch id="announce-replies" checked={announceReplies} onCheckedChange={setAnnounce} /><FieldLabel htmlFor="announce-replies" className="gap-1.5 text-xs font-medium text-foreground"><Volume2Icon />{t('announceReplies')}</FieldLabel></Field>
          </div>
          <span className="whitespace-nowrap text-xs text-muted-foreground">{transcribing ? t('transcribing') : t('composeHint')}</span>
        </InputGroupAddon>
      </InputGroup>
      <p className="sr-only">{t('mainThread')}</p>
    </form>
  </>
}

function BrowserPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const queryClient = useQueryClient()
  const previewRef = useRef<HTMLDivElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const sendInputRef = useRef<(input: Record<string, unknown>) => Promise<void>>(async () => {})
  const [targetDevice, setTargetDevice] = useState('__controller__')
  const effectiveTargetDevice = targetDevice === '__controller__' ? '' : targetDevice
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token), refetchInterval: 3000 })
  const targetQuery = effectiveTargetDevice ? `?target_device=${encodeURIComponent(effectiveTargetDevice)}` : ''
  const sessions = useQuery({ queryKey: ['browser-sessions', effectiveTargetDevice], queryFn: () => api<BrowserSession[]>(`/api/browser/sessions${targetQuery}`, token), refetchInterval: 1000 })
  const [selectedId, setSelectedId] = useState('')
  const [browserInput, setBrowserInput] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [previewReady, setPreviewReady] = useState(false)
  const selected = sessions.data?.find((session) => session.id === selectedId) ?? sessions.data?.[0]
  const targets = [{ machine_id: '', name: t('controller'), online: true }, ...(peers.data ?? []).filter((peer) => peer.online)]

  useEffect(() => { setSelectedId('') }, [targetDevice])
  useEffect(() => { if (selected && selected.id !== selectedId) setSelectedId(selected.id) }, [selected, selectedId])
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['browser-sessions', effectiveTargetDevice] }) }
  const create = async (event: FormEvent) => {
    event.preventDefault(); setCreating(true); setError('')
    try { const session = await api<BrowserSession>('/api/browser/sessions', token, { method: 'POST', body: JSON.stringify({ target_device: effectiveTargetDevice }) }); setSelectedId(session.id); await refresh() }
    catch (cause) { setError(message(cause)) } finally { setCreating(false) }
  }
  const sendInput = async (input: Record<string, unknown>) => {
    if (!selected) return
    setError('')
    try { await api(`/api/browser/sessions/${selected.id}/input${targetQuery}`, token, { method: 'POST', body: JSON.stringify(input) }) }
    catch (cause) { setError(message(cause)) }
  }
  sendInputRef.current = sendInput
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController(); let active = true; let decoding = false; let latest: Uint8Array<ArrayBufferLike> | undefined; let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array()
    setPreviewReady(false)
    const drawLatest = async () => { if (decoding || !latest) return; decoding = true; const frame = latest; latest = undefined; try { const bytes = new Uint8Array(frame.byteLength); bytes.set(frame); const bitmap = await createImageBitmap(new Blob([bytes.buffer], { type: 'image/png' })); if (active) { const canvas = previewCanvasRef.current; const context = canvas?.getContext('2d'); if (canvas && context) { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); setPreviewReady(true) } } bitmap.close() } finally { decoding = false; if (active && latest) void drawLatest() } }
    const receive = async () => { const response = await authenticatedFetch(token, `/api/browser/sessions/${selected.id}/stream${targetQuery}`, { signal: controller.signal }); if (!response.ok) throw new Error(response.statusText); const reader = response.body?.getReader(); if (!reader) throw new Error('Browser preview stream is unavailable.'); while (active) { const { done, value } = await reader.read(); if (done) return; const appended = new Uint8Array(buffered.length + value.length); appended.set(buffered); appended.set(value, buffered.length); buffered = appended; while (active) { const [frame, remainder] = nextBrowserFrame(buffered); buffered = remainder; if (!frame) break; latest = frame; void drawLatest() } } }
    void receive().catch((cause) => { if (active && !controller.signal.aborted) setError(message(cause)) })
    return () => { active = false; controller.abort() }
  }, [selected?.id, targetQuery, token])
  useEffect(() => {
    const preview = previewRef.current; if (!preview) return
    let pendingDelta = 0; let sending = false; let scheduled = false
    const flush = () => { scheduled = false; if (sending || pendingDelta === 0) return; const delta_y = pendingDelta; pendingDelta = 0; sending = true; void sendInputRef.current({ type: 'scroll', delta_y }).finally(() => { sending = false; if (pendingDelta && !scheduled) { scheduled = true; requestAnimationFrame(flush) } }) }
    const onWheel = (event: WheelEvent) => { event.preventDefault(); pendingDelta += event.deltaY; if (!scheduled) { scheduled = true; requestAnimationFrame(flush) } }
    preview.addEventListener('wheel', onWheel, { passive: false }); return () => preview.removeEventListener('wheel', onWheel)
  }, [selected?.id])
  const typeInput = async (event: FormEvent) => { event.preventDefault(); if (!browserInput.trim()) return; await sendInput({ type: 'type', text: browserInput }); setBrowserInput('') }
  const close = async () => { if (!selected) return; try { await api(`/api/browser/sessions/${selected.id}${targetQuery}`, token, { method: 'DELETE' }); setSelectedId(''); await refresh() } catch (cause) { setError(message(cause)) } }
  const approve = async () => { if (!selected) return; try { await api(`/api/browser/sessions/${selected.id}/approve${targetQuery}`, token, { method: 'POST' }); await refresh() } catch (cause) { setError(message(cause)) } }
  if (sessions.error || peers.error) return <Page title={t('browserTitle')} description={t('browserDescription')}><ErrorAlert error={message(sessions.error || peers.error)} /></Page>
  return <Page title={t('browserTitle')} description={t('browserDescription')}><Card><CardHeader><CardTitle>{t('createBrowser')}</CardTitle><CardDescription>{t('browserCreateHint')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={create}>{error && <ErrorAlert error={error} />}<Field><FieldLabel htmlFor="browser-target">{t('machine')}</FieldLabel><Select value={targetDevice} onValueChange={setTargetDevice}><SelectTrigger id="browser-target"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectLabel>{t('machine')}</SelectLabel>{targets.map((target) => <SelectItem key={target.machine_id || 'controller'} value={target.machine_id || '__controller__'}>{target.name}</SelectItem>)}</SelectGroup></SelectContent></Select></Field><Button className="w-fit" disabled={creating}>{creating && <Spinner data-icon="inline-start" />}{t('createBrowser')}</Button></form></CardContent></Card>{sessions.data && sessions.data.length > 0 ? <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]"><Card><CardHeader><CardTitle>{t('selectBrowser')}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2">{sessions.data.map((session) => <Button key={session.id} variant={selected?.id === session.id ? 'secondary' : 'outline'} className="h-auto justify-start whitespace-normal text-left" onClick={() => setSelectedId(session.id)}><span><strong>{session.url}</strong><br /><span className="text-xs text-muted-foreground">{session.target_name} · {formatTimestamp(language, session.created_at)}</span></span></Button>)}</CardContent></Card><Card><CardHeader><div className="flex flex-wrap items-center gap-2"><div className="flex-1"><CardTitle>{t('browserLiveView')}</CardTitle><CardDescription>{selected?.target_name} · {selected?.url}</CardDescription></div>{selected?.pending_approval && <Button onClick={() => void approve()}>{t('approveAction')}</Button>}<Button variant="outline" onClick={() => void close()}>{t('closeBrowser')}</Button></div>{selected?.pending_approval && <Alert><AlertTitle>{t('approveAction')}</AlertTitle><AlertDescription>{selected.pending_approval.description}</AlertDescription></Alert>}</CardHeader><CardContent className="flex flex-col gap-4"><div ref={previewRef} className="relative overflow-hidden rounded-md border bg-muted"><canvas ref={previewCanvasRef} aria-label={t('browserLiveView')} className="block aspect-[8/5] w-full cursor-crosshair" height={800} width={1280} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); void sendInput({ type: 'click', x: (event.clientX - bounds.left) * 1280 / bounds.width, y: (event.clientY - bounds.top) * 800 / bounds.height }) }} />{!previewReady && <div className="absolute inset-0 grid place-items-center"><Spinner /></div>}</div><p className="text-xs text-muted-foreground">{t('browserClickHint')}</p><form className="flex gap-2" onSubmit={(event) => void typeInput(event)}><Input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} placeholder={t('browserInput')} /><Button type="submit">{t('sendBrowserInput')}</Button></form></CardContent></Card></div> : <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('noBrowserSessions')}</CardContent></Card>}</Page>
}

function ConversationEntry({ item, now, peers, onResend, resendingMessageId }: { item: ConversationItem; now: number; peers: Peer[]; onResend?: (message: ChatMessage) => void; resendingMessageId?: number | null }) {
  const { language, t } = useUi()
  const [parametersOpen, setParametersOpen] = useState(false)
  if (item.kind === 'reasoning') return <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"><BrainCircuitIcon className="mt-0.5 size-4 shrink-0 text-foreground" /><div className="min-w-0"><span>{t('reasoningRecorded')} · {t('reasoningPersisted')}</span>{item.summary ? <div className="prose prose-sm mt-1 max-w-none text-foreground dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.summary}</ReactMarkdown></div> : <span className="ml-1">· {t('reasoningSummaryUnavailable')} · {t('reasoningWithheld')}</span>}</div></div>
  if (item.kind === 'handoff') return <SubthreadHandoffEntry item={item} />
  if (item.kind === 'fallback') return <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"><FileTextIcon className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-all"><code>{item.label}</code> · {t('detailsUnavailable')}</span></div>
  if (item.kind === 'tool') {
    const path = stringValue(item.arguments.path)
    const command = stringValue(item.arguments.command)
    const query = stringValue(item.arguments.query)
    const queries = Array.isArray(item.arguments.queries) ? item.arguments.queries.filter((value): value is string => typeof value === 'string').join(', ') : ''
    const targetDevice = item.arguments.target_device
    const targetDeviceLabel = typeof targetDevice !== 'string' ? '' : targetDevice === '' ? '【本机】' : peers.find((peer) => peer.machine_id === targetDevice)?.name ?? targetDevice
    const action = item.complete ? { list_files: t('listedFiles'), read_file: t('readFile'), write_file: t('wroteFile'), edit_file: t('wroteFile'), run_bash: t('ranCommand'), web_search: t('searchedWeb'), image_generation: t('generatedImage'), load_skill: t('skillLoaded'), read_skill_resource: t('resourceRead') }[item.name] : { list_files: t('listingFiles'), read_file: t('readingFile'), write_file: t('writingFile'), edit_file: t('writingFile'), run_bash: t('runningCommand'), web_search: t('searchingWeb'), image_generation: t('generatingImage'), load_skill: t('skillLoading'), read_skill_resource: t('resourceReading') }[item.name]
    const skill = stringValue(item.arguments.name) || stringValue(item.arguments.skill)
    const resourcePath = stringValue(item.arguments.relative_path).replace(/^\/+/, '')
    const knownSkillTool = item.name === 'load_skill' || item.name === 'read_skill_resource'
    const target = knownSkillTool ? (item.name === 'load_skill' ? skill : [skill, resourcePath].filter(Boolean).join(' · ')) : command || path || query || queries || item.name
    const parameters = knownSkillTool ? '' : Object.keys(item.arguments).length ? JSON.stringify(targetDeviceLabel ? { ...item.arguments, target_device: targetDeviceLabel } : item.arguments, null, 2) : ''
    const changes = item.complete && (item.name === 'write_file' || item.name === 'edit_file') && item.added_lines !== undefined && item.deleted_lines !== undefined ? ` · ${t('addedLines')} ${item.added_lines ?? 0} ${t('lines')} · ${t('deletedLines')} ${item.deleted_lines ?? 0} ${t('lines')}` : ''
    const started = item.started_at ? Date.parse(item.started_at) : NaN
    const finished = item.finished_at ? Date.parse(item.finished_at) : now
    const elapsed = Number.isNaN(started) ? null : Math.max(0, Math.floor((finished - started) / 1000))
    const duration = elapsed === null ? '' : ` · ${t('duration')}: ${elapsed} ${t('seconds')}`
    if (item.subthreadAction) return <SubthreadToolEntry item={item} />
    return <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">{item.complete ? item.name === 'run_bash' ? <TerminalSquareIcon className="mt-0.5 size-5 shrink-0 text-foreground" /> : <CheckIcon className={`mt-0.5 shrink-0 text-foreground ${item.name === 'web_search' ? 'size-5' : 'size-4'}`} /> : <Spinner className="mt-0.5 shrink-0" />}<div className="min-w-0 break-all"><span>{action ?? item.name} <code className="font-mono text-foreground">{target || t('detailsUnavailable')}</code>{targetDeviceLabel && <> · {targetDeviceLabel}</>}{changes}{duration}</span>{parameters && <div className="mt-1 text-xs"><Button aria-expanded={parametersOpen} size="sm" variant="ghost" onClick={() => setParametersOpen((open) => !open)}>{parametersOpen ? t('hideParameters') : t('showParameters')}</Button>{parametersOpen && <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-foreground"><code>{parameters}</code></pre>}</div>}</div></div>
  }
  if (item.message.role !== 'assistant') return <Message align="end"><MessageContent className="gap-1.5"><Card size="sm"><CardContent className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></CardContent></Card>{item.message.role === 'user' && item.message.id !== undefined && onResend && <MessageFooter className="justify-end px-0"><ResendMessageButton message={item.message} disabled={resendingMessageId !== undefined && resendingMessageId !== null} resending={resendingMessageId === item.message.id} onResend={onResend} /></MessageFooter>}</MessageContent></Message>
  const timestamp = item.message.created_at ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.message.created_at)) : null
  const duration = item.message.duration_ms === undefined ? null : `${t('duration')}: ${(item.message.duration_ms / 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })} ${t('seconds')}`
  const tokens = item.message.input_tokens === undefined || item.message.output_tokens === undefined ? null : `${(item.message.input_tokens + item.message.output_tokens).toLocaleString()} ${t('tokens')}`
  return <Message><MessageContent className="gap-1.5"><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content ?? ''}</ReactMarkdown></div>{item.message.images?.map((image) => { const source = image.preview_content ?? (image.data ? `data:image/png;base64,${image.data}` : ''); return source ? <Card key={image.id} size="sm"><CardContent className="p-0"><img alt={t('generatedImage')} className="max-w-full" src={source} /></CardContent></Card> : null })}<MessageFooter className="gap-2 px-0 font-normal">{[timestamp, duration, tokens].filter(Boolean).map((detail) => <span key={detail}>{detail}</span>)}{item.message.content && <ManualAnnouncementButton content={item.message.content} />}</MessageFooter></MessageContent></Message>
}

function SubthreadHandoffEntry({ item }: { item: Extract<ConversationItem, { kind: 'handoff' }> }) {
  const { language, t } = useUi()
  const title = item.subthread?.title || t('delegatedGoal')
  const terminalState = ['active', 'achieved', 'blocked', 'cancelled'].includes(item.terminalState) ? goalStateLabel(language, item.terminalState as GoalState) : item.terminalState || t('detailsUnavailable')
  const metadata = <><span className="text-xs text-muted-foreground">{t('goalHandoff')}</span><strong className="block break-words text-foreground">{title}</strong><span className="mt-1 flex flex-wrap gap-1"><Badge variant={item.terminalState === 'achieved' ? 'secondary' : 'outline'}>{terminalState}</Badge>{item.subthread && <><Badge variant="outline">{item.subthread.model}</Badge><Badge variant="outline">{threadStatusLabel(t, item.subthread.status)}</Badge></>}</span>{(item.result || item.detail) && <span className="mt-1 block whitespace-pre-wrap text-xs text-muted-foreground">{item.result || item.detail}</span>}</>
  return <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"><GitForkIcon className="mt-0.5 size-4 shrink-0 text-foreground" /><div className="min-w-0">{item.subthread ? <Link className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/threads/${item.subthread.id}`}>{metadata}</Link> : <div>{metadata}</div>}</div></div>
}

function SubthreadToolEntry({ item }: { item: Extract<ConversationItem, { kind: 'tool' }> }) {
  const { t } = useUi()
  const title = item.subthread?.title ?? (typeof item.arguments.title === 'string' ? item.arguments.title : t('threads'))
  const task = item.subthread?.task ?? (typeof item.arguments.task === 'string' ? item.arguments.task : '')
  const action = item.complete ? t('completed') : item.subthreadAction === 'fork' ? t('calling') : item.subthreadAction === 'cancel' ? t('commandCancelled') : t('retrying')
  const content = <><span className="text-xs text-muted-foreground">{action}</span><strong className="block truncate text-foreground">{title}</strong>{task && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{task}</span>}{item.subthread && <span className="mt-1 flex flex-wrap gap-1"><Badge variant="outline">{item.subthread.model}</Badge><Badge variant={item.subthread.goal_state === 'active' ? 'secondary' : 'outline'}>{item.subthread.status}</Badge></span>}</>
  return <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground"><GitForkIcon className="mt-0.5 size-4 shrink-0 text-foreground" /><div className="min-w-0">{item.subthread ? <Link className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" to={`/threads/${item.subthread.id}`}>{content}</Link> : <div>{content}</div>}</div></div>
}

function ResendMessageButton({ message, disabled, resending, onResend }: { message: ChatMessage; disabled: boolean; resending: boolean; onResend: (message: ChatMessage) => void }) {
  const { t } = useUi()
  const [open, setOpen] = useState(false)
  return <><Button aria-label={t('resendMessage')} title={t('resendMessage')} disabled={disabled} size="icon-sm" type="button" variant="ghost" onClick={() => setOpen(true)}>{resending ? <Spinner /> : <RefreshCwIcon />}</Button><Dialog open={open} onOpenChange={(next) => { if (!resending) setOpen(next) }}><DialogContent className="sm:max-w-md" showCloseButton={!resending}><DialogHeader><DialogTitle>{t('resendMessageConfirmTitle')}</DialogTitle><DialogDescription>{t('resendMessageConfirmDescription')}</DialogDescription></DialogHeader><DialogFooter><DialogClose asChild><Button variant="outline" disabled={resending}>{t('cancel')}</Button></DialogClose><Button disabled={resending} onClick={() => { setOpen(false); onResend(message) }}>{resending && <Spinner data-icon="inline-start" />}{resending ? t('resendingMessage') : t('resendMessageConfirm')}</Button></DialogFooter></DialogContent></Dialog></>
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
  const { language, t } = useUi()
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token), refetchInterval: 5000 })
  const [pairing, setPairing] = useState<ExecutorPairing | null>(null)
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const command = pairing ? `cybion --pair '${pairing.pairing_url}'` : ''
  const createPairing = async () => {
    setCreating(true)
    try {
      setPairing(await api<ExecutorPairing>('/api/executors/pairings', token, { method: 'POST' }))
      setCopied(false)
      setError('')
    } catch (cause) { setError(message(cause)) } finally { setCreating(false) }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch (cause) { setError(message(cause)) }
  }
  const expiresAt = pairing && new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(pairing.expires_at))
  return <Page title={t('machinesTitle')} description={t('machinesDescription')}><Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>{t('pairExecutor')}</CardTitle><CardDescription>{t('pairExecutorDescription')}</CardDescription></div><Button disabled={creating} onClick={() => void createPairing()}>{creating && <Spinner data-icon="inline-start" />}{t('pairExecutor')}</Button></div></CardHeader>{pairing && <CardContent className="flex flex-col gap-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{t('pairingCommand')}</p><Badge variant="outline">{t('pairingExpires').replace('{time}', expiresAt ?? '')}</Badge></div><div className="flex gap-2"><Input aria-label={t('pairingCommand')} value={command} readOnly className="font-mono text-xs" /><Button type="button" variant="outline" onClick={() => void copy()}><CopyIcon data-icon="inline-start" />{copied ? t('copied') : t('copy')}</Button></div><p className="text-sm text-muted-foreground">{t('pairingOneTime')}</p></CardContent>}{error && <CardContent><ErrorAlert error={error} /></CardContent>}</Card><Card><CardHeader><CardTitle>{t('enrolledMachines')}</CardTitle><CardDescription>{t('pairingOneTime')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{peers.data?.map((peer) => <div key={peer.id} className="flex items-start gap-3 rounded-lg border p-3"><ServerIcon /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{peer.name}</p><Badge variant="outline">{t('executor')}</Badge><Badge variant={peer.online ? 'secondary' : 'outline'}>{peer.online ? t('online') : 'Offline'}</Badge><Badge variant={peer.resource_status === 'online' ? 'secondary' : 'outline'}>{t(peer.resource_status === 'online' ? 'resourceOnline' : peer.resource_status === 'stale' ? 'resourceStale' : 'resourceUnavailable')}</Badge></div><p className="truncate text-sm text-muted-foreground">{peer.hostname}</p>{peer.resource_sampled_at && <p className="mt-1 text-xs text-muted-foreground">{t('resourceReceivedAt').replace('{time}', formatTimestamp(language, peer.resource_sampled_at))}</p>}{peer.resource ? <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4"><span><b>{t('cpu')}</b> {peer.resource.cpu.usage_percent.toFixed(0)}%</span><span><b>{t('memory')}</b> {formatBytes(peer.resource.memory.used_bytes)} / {formatBytes(peer.resource.memory.total_bytes)}</span><span><b>{t('disk')}</b> {peer.resource.disk ? `${peer.resource.disk.usage_percent.toFixed(0)}%` : '—'}</span><span><b>{t('network')}</b> ↓{formatBytes(peer.resource.network.receive_bytes_per_second)}/s ↑{formatBytes(peer.resource.network.transmit_bytes_per_second)}/s</span></div> : <p className="mt-2 text-xs text-muted-foreground">{t('unavailable')}</p>}<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{peer.machine_id}</p></div><Button aria-label={`${t('remove')}: ${peer.name}`} title={t('remove')} variant="ghost" size="icon-sm" onClick={async () => { await api(`/api/peers/${peer.id}`, token, { method: 'DELETE' }); await peers.refetch() }}><XIcon /></Button></div>)}{peers.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('noMachines')}</p>}</CardContent></Card></Page>
}
function StoredFilePreview({ file, full = false, className = '' }: { file: StoredFile; full?: boolean; className?: string }) {
  const token = useAuthToken()
  const [source, setSource] = useState(file.preview_content ?? '')
  useEffect(() => {
    if (!full) { setSource(file.preview_content ?? ''); return }
    let active = true
    let objectUrl = ''
    void authenticatedFetch(token, `/api/file-objects/${encodeURIComponent(file.id)}/content`).then(async (response) => {
      if (!response.ok) throw new Error(response.statusText)
      objectUrl = URL.createObjectURL(await response.blob())
      if (active) setSource(objectUrl)
      else URL.revokeObjectURL(objectUrl)
    }).catch(() => { if (active) setSource(file.preview_content ?? '') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file.id, file.preview_content, full, token])
  return source ? <img alt={file.filename} className={className} src={source} /> : <div aria-label={file.filename} className={`grid place-items-center bg-muted text-muted-foreground ${className}`}><ImageIcon /></div>
}

function FileObjectsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const queryClient = useQueryClient()
  const pickerRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState('all')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const files = useQuery({ queryKey: ['file-objects', kind], queryFn: () => api<StoredFile[]>(`/api/file-objects?kind=${kind}`, token) })
  const upload = async (selected: FileList | null) => {
    if (!selected?.length) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(selected)) await uploadStoredFile(token, file)
      await queryClient.invalidateQueries({ queryKey: ['file-objects'] })
    } catch (cause) { setError(message(cause)) } finally { setUploading(false) }
  }
  const created = (value: string) => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
  return <Page title={t('fileObjectsTitle')} description={t('fileObjectsDescription')}><input ref={pickerRef} className="sr-only" type="file" multiple onChange={(event) => { void upload(event.target.files); event.currentTarget.value = '' }} /><div className="flex flex-wrap items-center justify-between gap-3"><Select value={kind} onValueChange={setKind}><SelectTrigger aria-label={t('fileType')} className="w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('allFileTypes')}</SelectItem><SelectItem value="images">{t('images')}</SelectItem><SelectItem value="documents">{t('documents')}</SelectItem><SelectItem value="media">{t('media')}</SelectItem><SelectItem value="other">{t('otherFiles')}</SelectItem></SelectContent></Select><Button disabled={uploading} onClick={() => pickerRef.current?.click()}>{uploading ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}{uploading ? t('uploadingFiles') : t('uploadFiles')}</Button></div>{error && <ErrorAlert error={error} />}{files.error && <ErrorAlert error={message(files.error)} />}{files.isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div> : files.data?.length ? <Card><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t('fileName')}</TableHead><TableHead>{t('fileType')}</TableHead><TableHead>{t('fileSize')}</TableHead><TableHead>{t('sourceHistory')}</TableHead><TableHead className="text-right">{goalText(language, 'actions')}</TableHead></TableRow></TableHeader><TableBody>{files.data.map((file) => <TableRow key={file.id}><TableCell className="min-w-64"><div className="flex min-w-0 items-center gap-3">{file.preview_content ? <StoredFilePreview file={file} className="size-10 shrink-0 rounded-md object-cover" /> : <FileIcon className="size-4 shrink-0 text-muted-foreground" />}<div className="min-w-0"><p className="truncate font-medium" title={file.filename}>{file.filename}</p><p className="truncate font-mono text-xs text-muted-foreground" title={file.id}>{file.id}</p></div></div></TableCell><TableCell><code className="text-xs">{file.mime_type}</code></TableCell><TableCell>{bytes(file.size)}</TableCell><TableCell>{file.history_entry_id ? <Button asChild size="sm" variant="ghost"><Link to={`/console?focus=${file.history_entry_id}`}><ArrowLeftIcon data-icon="inline-start" />#{file.history_entry_id}</Link></Button> : <span className="text-sm text-muted-foreground">{t('historyUnavailable')}</span>}</TableCell><TableCell><div className="flex justify-end gap-1"><Button aria-label={`${t('download')}: ${file.filename}`} size="icon-sm" variant="ghost" onClick={() => void downloadStoredFile(token, file)}><DownloadIcon /></Button></div></TableCell></TableRow>)}</TableBody></Table></div><CardContent className="border-t py-3 text-xs text-muted-foreground">{files.data.length} · {created(files.data[0].created_at)}</CardContent></Card> : <Card><CardContent className="py-10 text-sm text-muted-foreground">{t('noFiles')}</CardContent></Card>}</Page>
}

function GalleryPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const images = useQuery({ queryKey: ['file-objects', 'images'], queryFn: () => api<StoredFile[]>('/api/file-objects?kind=images', token) })
  const [selected, setSelected] = useState<StoredFile | null>(null)
  return <Page title={t('galleryTitle')} description={t('galleryDescription')}>{images.error && <ErrorAlert error={message(images.error)} />}{images.isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div> : images.data?.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{images.data.map((file) => <button key={file.id} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left transition-colors hover:border-foreground/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelected(file)}><StoredFilePreview file={file} className="size-full object-cover transition-transform duration-200 motion-safe:group-hover:scale-[1.02]" /><span className="absolute inset-x-0 bottom-0 bg-background/90 px-2 py-1.5 text-xs font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><span className="block truncate">{file.filename}</span></span></button>)}</div> : <Card><CardContent className="py-10 text-sm text-muted-foreground">{t('noImages')}</CardContent></Card>}<Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>{selected?.filename}</DialogTitle><DialogDescription>{selected?.mime_type} · {selected ? bytes(selected.size) : ''}</DialogDescription></DialogHeader>{selected && <div className="grid gap-4"><div className="grid min-h-48 place-items-center overflow-hidden rounded-lg bg-muted"><StoredFilePreview file={selected} full className="max-h-[65svh] max-w-full object-contain" /></div><div className="flex flex-wrap items-center gap-2"><Button onClick={() => void downloadStoredFile(token, selected)}><DownloadIcon data-icon="inline-start" />{t('download')}</Button>{selected.history_entry_id && <Button asChild variant="outline"><Link to={`/console?focus=${selected.history_entry_id}`}><ArrowLeftIcon data-icon="inline-start" />{t('openOriginal')}</Link></Button>}<code className="ml-auto max-w-full truncate text-xs text-muted-foreground" title={selected.id}>{selected.id}</code></div></div>}</DialogContent></Dialog></Page>
}

type CommandFilter = { page: number; pageSize: number; status: 'all' | CommandRun['status']; targetMachineId: string; query: string }
type CommandOutput = { stdout?: string; stderr?: string; raw?: string }

function commandOutput(result: string | null): CommandOutput | null {
  if (!result) return null
  try {
    const value: unknown = JSON.parse(result)
    if (typeof value === 'object' && value !== null) {
      const output = value as Record<string, unknown>
      const stdout = typeof output.stdout === 'string' ? output.stdout : undefined
      const stderr = typeof output.stderr === 'string' ? output.stderr : undefined
      if (stdout !== undefined || stderr !== undefined) return { stdout, stderr }
    }
  } catch { return { raw: result } }
  return { raw: result }
}

function CommandResult({ result }: { result: string | null }) {
  const { t } = useUi()
  const output = commandOutput(result)
  if (!output) return <p className="text-sm text-muted-foreground">{t('commandNoResult')}</p>
  return <details className="rounded-lg border bg-muted/30 px-3 py-2"><summary className="cursor-pointer text-sm font-medium">{t('commandViewResult')}</summary><div className="mt-3 grid gap-3">{output.raw !== undefined ? <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"><code>{output.raw}</code></pre> : <>{output.stdout !== undefined && <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t('commandStdout')}</p><pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"><code>{output.stdout || '—'}</code></pre></div>}{output.stderr && <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t('commandStderr')}</p><pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all"><code>{output.stderr}</code></pre></div>}</>}</div></details>
}

function InsightsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const [filters, setFilters] = useState<InsightFilter>({ range: '7d', threadId: 'all', model: 'all', requestKind: 'all' })
  const insights = useQuery({ queryKey: ['insights', filters], queryFn: () => { const params = new URLSearchParams({ range: filters.range }); if (filters.threadId !== 'all') params.set('thread_id', filters.threadId); if (filters.model !== 'all') params.set('model', filters.model); if (filters.requestKind !== 'all') params.set('request_kind', filters.requestKind); return api<Insights>(`/api/insights?${params}`, token) } })
  const number = (value: number) => value.toLocaleString(language === 'zh' ? 'zh-CN' : 'en')
  const rate = (value: number | null) => value === null ? '—' : `${value.toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })}%`
  const clear = () => setFilters({ range: '7d', threadId: 'all', model: 'all', requestKind: 'all' })
  if (insights.error) return <Page title={t('insightsTitle')} description={t('insightsDescription')}><ErrorAlert error={message(insights.error)} /></Page>
  if (!insights.data) return <Page title={t('insightsTitle')} description={t('insightsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  const data = insights.data
  const tokenMetrics = [[t('insightsCompletedRequests'), number(data.tokens.completed_requests)], [t('insightsInput'), number(data.tokens.input_tokens)], [t('insightsOutput'), number(data.tokens.output_tokens)], [t('insightsTotal'), number(data.tokens.total_tokens)], [t('insightsCached'), number(data.tokens.cached_tokens)], [t('insightsCacheRate'), rate(data.tokens.cache_hit_rate)]]
  const historyMetrics = [[t('insightsHistoryRecords'), number(data.history.total_records)], [t('insightsPayloadBytes'), bytes(data.history.payload_bytes)], [t('insightsCheckpoints'), number(data.history.checkpoint_count)], [t('insightsLatestRecord'), data.history.latest_record_at ? formatTimestamp(language, data.history.latest_record_at) : '—']]
  const statuses = [['completed', data.requests.completed], ['in_flight', data.requests.in_flight], ['failed', data.requests.failed], ['cancelled', data.requests.cancelled], ['interrupted', data.requests.interrupted]].filter(([, count]) => Number(count) > 0)
  return <Page title={t('insightsTitle')} description={t('insightsDescription')}><Card><CardContent className="pt-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5"><Select value={filters.range} onValueChange={(value) => setFilters((current) => ({ ...current, range: value as InsightFilter['range'] }))}><SelectTrigger aria-label={t('insightsRange')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="24h">{t('insights24h')}</SelectItem><SelectItem value="7d">{t('insights7d')}</SelectItem><SelectItem value="30d">{t('insights30d')}</SelectItem><SelectItem value="all">{t('insightsAll')}</SelectItem></SelectContent></Select><Select value={filters.threadId} onValueChange={(value) => setFilters((current) => ({ ...current, threadId: value }))}><SelectTrigger aria-label={t('insightsThread')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('insightsAllThreads')}</SelectItem><SelectItem value="main">{t('insightsMainThread')}</SelectItem>{data.dimensions.thread_ids.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectContent></Select><Select value={filters.model} onValueChange={(value) => setFilters((current) => ({ ...current, model: value }))}><SelectTrigger aria-label={t('insightsModel')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('insightsAllModels')}</SelectItem>{data.dimensions.models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent></Select><Select value={filters.requestKind} onValueChange={(value) => setFilters((current) => ({ ...current, requestKind: value }))}><SelectTrigger aria-label={t('insightsKind')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('insightsAllKinds')}</SelectItem>{data.dimensions.request_kinds.map((kind) => <SelectItem key={kind} value={kind}>{reasoningAuditPurpose(t, kind)}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" onClick={clear}><XIcon data-icon="inline-start" />{t('insightsClearFilters')}</Button></div></CardContent></Card><p className="text-xs text-muted-foreground">{t('insightsGenerated').replace('{time}', formatTimestamp(language, data.generated_at))}</p><section className="grid gap-4 xl:grid-cols-2"><Card><CardHeader><CardTitle>{t('insightsTokenUsage')}</CardTitle><CardDescription>{data.tokens.cache_hit_rate === null ? t('insightsCacheUnavailable') : t('insightsCacheFormula')}</CardDescription></CardHeader><CardContent><dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">{tokenMetrics.map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-mono text-lg font-medium tabular-nums">{value}</dd></div>)}</dl></CardContent></Card><Card><CardHeader><CardTitle>{t('insightsRequestHealth')}</CardTitle><CardDescription>{number(data.requests.total)} {t('reasoningAudit')} · UTC</CardDescription></CardHeader><CardContent>{statuses.length ? <div className="grid gap-3 sm:grid-cols-2">{statuses.map(([status, count]) => { const detail = reasoningAuditStatus(t, String(status) as ReasoningAuditStatus); return <div className="flex items-center justify-between rounded-lg border px-3 py-2" key={String(status)}><Badge variant={detail.variant}>{detail.label}</Badge><span className="font-mono text-sm tabular-nums">{number(Number(count))}</span></div> })}</div> : <p className="text-sm text-muted-foreground">{t('reasoningAuditEmpty')}</p>}</CardContent></Card></section><section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]"><Card><CardHeader><CardTitle>{t('insightsHistory')}</CardTitle><CardDescription>{t('insightsHistoryDescription')}</CardDescription></CardHeader><CardContent><dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{historyMetrics.map(([label, value]) => <div key={String(label)}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd></div>)}</dl></CardContent></Card><Card><CardHeader><CardTitle>{t('insightsDistribution')}</CardTitle><CardDescription>{t('insightsHistory')}</CardDescription></CardHeader><CardContent>{data.history.kinds.length ? <div className="flex flex-col gap-3">{data.history.kinds.map((kind) => <div className="flex items-center justify-between gap-3" key={kind.key}><code className="text-xs">{kind.key}</code><div className="flex min-w-0 flex-1 items-center gap-2"><Progress value={data.history.total_records ? kind.count / data.history.total_records * 100 : 0} /><span className="w-12 text-right font-mono text-xs tabular-nums">{number(kind.count)}</span></div></div>)}</div> : <p className="text-sm text-muted-foreground">{t('historyRecordEmpty')}</p>}</CardContent></Card></section></Page>
}

function HistoryRecordsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1)
  const pageSize = [20, 50, 100].includes(Number(searchParams.get('page_size'))) ? Number(searchParams.get('page_size')) : 50
  const filters: HistoryRecordFilter = {
    itemType: searchParams.get('type') ?? '', kind: searchParams.get('kind') ?? '', role: searchParams.get('role') ?? '', name: searchParams.get('name') ?? '', threadId: searchParams.get('thread_id') ?? '', callId: searchParams.get('call_id') ?? '',
  }
  const [draft, setDraft] = useState(filters)
  const filterKey = searchParams.toString()
  useEffect(() => { setDraft(filters) }, [filterKey])
  const setParams = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(changes).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key))
    setSearchParams(next)
  }
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
  if (filters.itemType) query.set('type', filters.itemType)
  if (filters.kind) query.set('kind', filters.kind)
  if (filters.role) query.set('role', filters.role)
  if (filters.name) query.set('name', filters.name)
  if (filters.threadId) query.set('thread_id', filters.threadId)
  if (filters.callId) query.set('call_id', filters.callId)
  const records = useQuery({ queryKey: ['history-records', query.toString()], queryFn: () => api<HistoryRecordPage>(`/api/history-records?${query}`, token) })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const detail = useQuery({ queryKey: ['history-record', selectedId], enabled: selectedId !== null, queryFn: () => api<HistoryRecordDetail>(`/api/history-records/${selectedId}`, token) })
  const totalPages = Math.max(1, Math.ceil((records.data?.total ?? 0) / pageSize))
  const rangeStart = records.data?.total ? (page - 1) * pageSize + 1 : 0
  const rangeEnd = Math.min(page * pageSize, records.data?.total ?? 0)
  const range = t('historyRecordRange').replace('{from}', String(rangeStart)).replace('{to}', String(rangeEnd)).replace('{total}', String(records.data?.total ?? 0))
  const pageLabel = t('historyRecordPage').replace('{page}', String(page)).replace('{pages}', String(totalPages))
  const activeFilters = [
    [t('historyRecordFilterType'), filters.itemType], [t('historyRecordFilterKind'), filters.kind], [t('historyRecordFilterRole'), filters.role], [t('historyRecordFilterName'), filters.name], [t('historyRecordFilterThread'), filters.threadId], [t('historyRecordFilterCall'), filters.callId],
  ].filter(([, value]) => value)
  useEffect(() => { if (page > totalPages) setParams({ page: String(totalPages) }) }, [page, totalPages])
  const applyFilters = (event: FormEvent) => {
    event.preventDefault()
    setParams({ page: '1', type: draft.itemType || null, kind: draft.kind || null, role: draft.role || null, name: draft.name || null, thread_id: draft.threadId || null, call_id: draft.callId || null })
  }
  const clearFilters = () => {
    setDraft({ itemType: '', kind: '', role: '', name: '', threadId: '', callId: '' })
    setSearchParams({ page: '1', page_size: String(pageSize) })
  }
  if (records.error) return <Page title={t('historyRecordsTitle')} description={t('historyRecordsDescription')}><ErrorAlert error={message(records.error)} /></Page>
  if (!records.data) return <Page title={t('historyRecordsTitle')} description={t('historyRecordsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('historyRecordsTitle')} description={t('historyRecordsDescription')}><Card><CardContent className="pt-4"><form className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" onSubmit={applyFilters}><Field><FieldLabel htmlFor="history-type">{t('historyRecordFilterType')}</FieldLabel><Input id="history-type" value={draft.itemType} onChange={(event) => setDraft((current) => ({ ...current, itemType: event.target.value }))} placeholder="function_call" /></Field><Field><FieldLabel>{t('historyRecordFilterKind')}</FieldLabel><Select value={draft.kind || 'all'} onValueChange={(value) => setDraft((current) => ({ ...current, kind: value === 'all' ? '' : value }))}><SelectTrigger aria-label={t('historyRecordFilterKind')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('historyRecordAll')}</SelectItem><SelectItem value="input">input</SelectItem><SelectItem value="response_output">response_output</SelectItem><SelectItem value="tool_output">tool_output</SelectItem><SelectItem value="checkpoint">checkpoint</SelectItem></SelectContent></Select></Field><Field><FieldLabel htmlFor="history-role">{t('historyRecordFilterRole')}</FieldLabel><Input id="history-role" value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} placeholder="assistant" /></Field><Field><FieldLabel htmlFor="history-name">{t('historyRecordFilterName')}</FieldLabel><Input id="history-name" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="run_bash" /></Field><Field><FieldLabel htmlFor="history-thread">{t('historyRecordFilterThread')}</FieldLabel><Input id="history-thread" value={draft.threadId} onChange={(event) => setDraft((current) => ({ ...current, threadId: event.target.value }))} /></Field><Field><FieldLabel htmlFor="history-call">{t('historyRecordFilterCall')}</FieldLabel><Input id="history-call" value={draft.callId} onChange={(event) => setDraft((current) => ({ ...current, callId: event.target.value }))} /></Field><div className="flex items-end gap-2"><Button type="submit">{t('historyRecordApplyFilters')}</Button><Button type="button" variant="outline" onClick={clearFilters}><XIcon data-icon="inline-start" />{t('historyRecordClearFilters')}</Button></div></form></CardContent></Card>{activeFilters.length > 0 && <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted-foreground">{t('historyRecordActiveFilters')}</span>{activeFilters.map(([label, value]) => <Badge key={String(label)} variant="secondary">{label}: {value}</Badge>)}</div>}<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{range}</p><div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{t('historyRecordPageSize')}</span><Select value={String(pageSize)} onValueChange={(value) => setParams({ page: '1', page_size: value })}><SelectTrigger aria-label={t('historyRecordPageSize')} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent></Select>{records.isFetching && <Spinner />}</div></div>{records.data.records.length === 0 ? <Card><CardContent className="pt-6 text-sm text-muted-foreground">{activeFilters.length > 0 ? t('historyRecordNoMatches') : t('historyRecordEmpty')}</CardContent></Card> : <ol className="overflow-hidden rounded-lg border divide-y">{records.data.records.map((record) => <li key={record.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1.5fr)_auto] sm:items-start"><div className="flex min-w-0 items-start gap-2"><Badge variant="outline">#{record.id}</Badge><div className="min-w-0"><p className="truncate font-mono text-sm font-medium">{record.kind}</p><p className="mt-1 text-xs text-muted-foreground">{formatTimestamp(language, record.created_at)}</p></div></div><div className="min-w-0"><div className="flex flex-wrap gap-1.5">{record.role && <Badge variant="secondary">{record.role}</Badge>}{record.item_type && <Badge variant="secondary">{record.item_type}</Badge>}{record.name && <Badge variant="secondary">{record.name}</Badge>}<Badge variant="outline">{bytes(record.payload_bytes)}</Badge></div><p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{record.summary}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">{record.thread_id && <span title={record.thread_id}>thread {record.thread_id.slice(0, 12)}</span>}{record.call_id && <span title={record.call_id}>call {record.call_id.slice(0, 12)}</span>}</div></div><Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setSelectedId(record.id)}><DatabaseIcon data-icon="inline-start" />{t('historyRecordView')}</Button></li>)}</ol>}<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{pageLabel}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}><ChevronLeftIcon data-icon="inline-start" />{t('historyRecordPreviousPage')}</Button><Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setParams({ page: String(page + 1) })}>{t('historyRecordNextPage')}<ChevronRightIcon data-icon="inline-end" /></Button></div></div><Dialog open={selectedId !== null} onOpenChange={(open) => { if (!open) setSelectedId(null) }}><DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-4xl"><DialogHeader><DialogTitle>{t('historyRecord')} #{detail.data?.id ?? selectedId}</DialogTitle><DialogDescription>{detail.data ? `${detail.data.kind} · ${formatTimestamp(language, detail.data.created_at)}` : t('loadingMachine')}</DialogDescription></DialogHeader>{detail.error ? <ErrorAlert error={message(detail.error)} /> : detail.data ? <div className="grid gap-4"><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('historyRecordLinks')}</dt><dd className="mt-1 break-all font-mono text-xs">{detail.data.thread_id ?? '—'}</dd></div><div><dt className="text-xs text-muted-foreground">{t('historyRecordType')}</dt><dd className="mt-1 font-mono text-xs">{detail.data.kind}</dd></div></dl><div><p className="mb-2 text-sm font-medium">{t('historyRecordPayload')}</p><pre className="max-h-[55svh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"><code>{JSON.stringify(detail.data.payload, null, 2)}</code></pre></div></div> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('loadingMachine')}</div>}</DialogContent></Dialog></Page>
}

function CommandsPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const [filters, setFilters] = useState<CommandFilter>({ page: 1, pageSize: 20, status: 'all', targetMachineId: 'all', query: '' })
  const [search, setSearch] = useState('')
  const commands = useQuery({ queryKey: ['commands', filters], queryFn: () => {
    const params = new URLSearchParams({ page: String(filters.page), page_size: String(filters.pageSize) })
    if (filters.status !== 'all') params.set('status', filters.status)
    if (filters.targetMachineId !== 'all') params.set('target_machine_id', filters.targetMachineId)
    if (filters.query) params.set('q', filters.query)
    return api<CommandRunPage>(`/api/commands?${params}`, token)
  }, refetchInterval: 1000 })
  const formatTime = (value: string | null) => value ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—'
  const status = (run: CommandRun) => run.status === 'running' ? { label: t('commandRunning'), variant: 'secondary' as const } : run.status === 'cancelled' ? { label: t('commandCancelled'), variant: 'outline' as const } : { label: t('commandComplete'), variant: 'default' as const }
  const totalPages = Math.max(1, Math.ceil((commands.data?.total ?? 0) / filters.pageSize))
  const rangeStart = commands.data?.total ? (filters.page - 1) * filters.pageSize + 1 : 0
  const rangeEnd = Math.min(filters.page * filters.pageSize, commands.data?.total ?? 0)
  const range = t('commandRange').replace('{from}', String(rangeStart)).replace('{to}', String(rangeEnd)).replace('{total}', String(commands.data?.total ?? 0))
  const pageLabel = t('commandPage').replace('{page}', String(filters.page)).replace('{pages}', String(totalPages))
  useEffect(() => { if (filters.page > totalPages) setFilters((value) => ({ ...value, page: totalPages })) }, [filters.page, totalPages])
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setFilters((value) => ({ ...value, page: 1, query: search.trim() })) }
  const clearFilters = () => { setSearch(''); setFilters((value) => ({ ...value, page: 1, status: 'all', targetMachineId: 'all', query: '' })) }
  const setPage = (page: number) => setFilters((value) => ({ ...value, page }))
  if (commands.error) return <Page title={t('commandsTitle')} description={t('commandsDescription')}><ErrorAlert error={message(commands.error)} /></Page>
  if (!commands.data) return <Page title={t('commandsTitle')} description={t('commandsDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('commandsTitle')} description={t('commandsDescription')}><Card><CardContent className="pt-4"><form className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_14rem_auto]" onSubmit={submitSearch}><InputGroup><InputGroupAddon><SearchIcon /></InputGroupAddon><InputGroupInput aria-label={t('commandSearch')} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('commandSearchPlaceholder')} /><InputGroupAddon align="inline-end"><InputGroupButton type="submit"><SearchIcon /></InputGroupButton></InputGroupAddon></InputGroup><Select value={filters.status} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, status: value as CommandFilter['status'] }))}><SelectTrigger aria-label={t('status')} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('commandAllStatuses')}</SelectItem><SelectItem value="running">{t('commandRunning')}</SelectItem><SelectItem value="complete">{t('commandComplete')}</SelectItem><SelectItem value="cancelled">{t('commandCancelled')}</SelectItem></SelectContent></Select><Select value={filters.targetMachineId} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, targetMachineId: value }))}><SelectTrigger aria-label={t('commandTarget')} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('commandAllMachines')}</SelectItem>{commands.data.target_machines.map((machine) => <SelectItem key={machine.id} value={machine.id}>{machine.name}</SelectItem>)}</SelectContent></Select><Button type="button" variant="outline" onClick={clearFilters}><XIcon data-icon="inline-start" />{t('commandClearFilters')}</Button></form></CardContent></Card><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{range}</p><div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{t('commandPageSize')}</span><Select value={String(filters.pageSize)} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, pageSize: Number(value) }))}><SelectTrigger aria-label={t('commandPageSize')} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectContent></Select>{commands.isFetching && <Spinner />}</div></div>{commands.data.items.length === 0 ? <Card><CardContent className="pt-6 text-sm text-muted-foreground">{filters.query || filters.status !== 'all' || filters.targetMachineId !== 'all' ? t('noCommandMatches') : t('noCommands')}</CardContent></Card> : <div className="flex flex-col gap-3">{commands.data.items.map((run) => { const runStatus = status(run); return <Card key={run.id} className={run.status === 'running' ? 'ring-primary/40' : ''}><CardHeader className="gap-3 border-b"><div className="flex flex-wrap items-center gap-2"><Badge variant={runStatus.variant}>{runStatus.label}</Badge><span className="text-xs text-muted-foreground">{formatTime(run.started_at)}</span></div><pre className="max-h-44 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"><code>{run.command}</code></pre><CardDescription className="flex min-w-0 items-start gap-2"><ServerIcon className="mt-0.5 size-4 shrink-0" /><span className="min-w-0"><span className="block text-foreground">{run.target_machine_name}</span><code className="block break-all text-xs">{run.target_machine_id}</code></span></CardDescription></CardHeader><CardContent className="grid gap-4"><dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="text-xs text-muted-foreground">{t('commandStartedAt')}</dt><dd className="mt-1">{formatTime(run.started_at)}</dd></div><div><dt className="text-xs text-muted-foreground">{t('commandFinishedAt')}</dt><dd className="mt-1">{formatTime(run.completed_at)}</dd></div><div><dt className="text-xs text-muted-foreground">{t('commandExitCode')}</dt><dd className="mt-1 font-mono">{run.exit_code ?? '—'}</dd></div></dl><CommandResult result={run.result} /></CardContent></Card> })}</div>}<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{pageLabel}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={filters.page <= 1} onClick={() => setPage(filters.page - 1)}><ChevronLeftIcon data-icon="inline-start" />{t('commandPreviousPage')}</Button><Button variant="outline" size="sm" disabled={filters.page >= totalPages} onClick={() => setPage(filters.page + 1)}>{t('commandNextPage')}<ChevronRightIcon data-icon="inline-end" /></Button></div></div></Page>
}

function reasoningAuditStatus(t: (key: TranslationKey) => string, status: ReasoningAuditStatus) {
  return status === 'in_flight'
    ? { label: t('reasoningAuditInFlight'), variant: 'secondary' as const }
    : status === 'completed'
      ? { label: t('reasoningAuditCompleted'), variant: 'default' as const }
      : status === 'failed'
        ? { label: t('reasoningAuditFailed'), variant: 'destructive' as const }
        : status === 'cancelled'
          ? { label: t('reasoningAuditCancelled'), variant: 'outline' as const }
          : { label: t('reasoningAuditInterrupted'), variant: 'outline' as const }
}

function reasoningAuditPurpose(t: (key: TranslationKey) => string, purpose: string) {
  return purpose === 'normal'
    ? t('reasoningAuditPurposeNormal')
    : purpose === 'compaction'
      ? t('reasoningAuditPurposeCompaction')
      : purpose === 'voice_script'
        ? t('reasoningAuditPurposeVoiceScript')
        : purpose === 'voice_turn_decision'
          ? t('reasoningAuditPurposeVoiceTurn')
          : purpose
}

function AuditThreadLink({ item }: { item: ReasoningAudit }) {
  const { t } = useUi()
  if (!item.thread_id) return <div className="flex min-w-36 flex-col gap-1"><Button asChild className="h-auto justify-start p-0 text-left" variant="link"><Link to="/console">{t('reasoningAuditMainThread')}</Link></Button><p className="max-w-64 truncate text-xs text-muted-foreground">{t('mainThreadDescription')}</p></div>
  const title = item.thread_title ?? t('reasoningAuditArchivedThread')
  const description = item.thread_task ?? t('reasoningAuditArchivedThreadDescription')
  return <div className="flex min-w-36 flex-col gap-1">{item.thread_title ? <Button asChild className="h-auto justify-start p-0 text-left" variant="link"><Link to={`/threads/${item.thread_id}`}>{title}</Link></Button> : <span className="font-medium">{title}</span>}<p className="max-w-64 truncate text-xs text-muted-foreground" title={description}>{description}</p></div>
}

function ReasoningAuditPage({ token }: { token: AuthMiniApi }) {
  const { language, t } = useUi()
  const [filters, setFilters] = useState<ReasoningAuditFilter>({ page: 1, pageSize: 50, status: 'all', threadId: 'all', model: 'all', requestKind: 'all' })
  const audits = useQuery({ queryKey: ['reasoning-audits', filters], queryFn: () => {
    const params = new URLSearchParams({ page: String(filters.page), page_size: String(filters.pageSize) })
    if (filters.status !== 'all') params.set('status', filters.status)
    if (filters.threadId !== 'all') params.set('thread_id', filters.threadId)
    if (filters.model !== 'all') params.set('model', filters.model)
    if (filters.requestKind !== 'all') params.set('request_kind', filters.requestKind)
    return api<ReasoningAuditPage>(`/api/reasoning-audits?${params}`, token)
  }, refetchInterval: 1000 })
  const totalPages = Math.max(1, Math.ceil((audits.data?.total ?? 0) / filters.pageSize))
  const rangeStart = audits.data?.total ? (filters.page - 1) * filters.pageSize + 1 : 0
  const rangeEnd = Math.min(filters.page * filters.pageSize, audits.data?.total ?? 0)
  const range = t('reasoningAuditRange').replace('{from}', String(rangeStart)).replace('{to}', String(rangeEnd)).replace('{total}', String(audits.data?.total ?? 0))
  const pageLabel = t('reasoningAuditPage').replace('{page}', String(filters.page)).replace('{pages}', String(totalPages))
  const formatTime = (value: string | null) => value ? formatTimestamp(language, value) : '—'
  const duration = (item: ReasoningAudit) => {
    const started = Date.parse(item.started_at)
    const finished = Date.parse(item.finished_at ?? new Date().toISOString())
    if (!Number.isFinite(started) || !Number.isFinite(finished)) return '—'
    return `${Math.max(0, (finished - started) / 1000).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })} ${t('seconds')}`
  }
  const tokenUsage = (item: ReasoningAudit) => {
    if (item.input_tokens === null && item.output_tokens === null && item.cached_tokens === null) return '—'
    const input = item.input_tokens?.toLocaleString() ?? '—'
    const output = item.output_tokens?.toLocaleString() ?? '—'
    const cached = item.cached_tokens?.toLocaleString() ?? '—'
    const cacheRate = item.input_tokens && item.cached_tokens !== null ? `${(item.cached_tokens / item.input_tokens * 100).toLocaleString(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: 1 })}%` : '—'
    return <div className="flex min-w-40 flex-col gap-1 text-xs tabular-nums"><span>in {input} · out {output}</span><span className="text-muted-foreground">cache {cached} · {cacheRate}</span></div>
  }
  useEffect(() => { if (filters.page > totalPages) setFilters((current) => ({ ...current, page: totalPages })) }, [filters.page, totalPages])
  const clearFilters = () => setFilters((current) => ({ ...current, page: 1, status: 'all', threadId: 'all', model: 'all', requestKind: 'all' }))
  if (audits.error) return <Page title={t('reasoningAuditTitle')} description={t('reasoningAuditDescription')}><ErrorAlert error={message(audits.error)} /></Page>
  if (!audits.data) return <Page title={t('reasoningAuditTitle')} description={t('reasoningAuditDescription')}><Card><CardContent className="flex items-center gap-2 pt-6"><Spinner />{t('loadingMachine')}</CardContent></Card></Page>
  return <Page title={t('reasoningAuditTitle')} description={t('reasoningAuditDescription')}>
    <Card><CardContent className="pt-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5"><Select value={filters.status} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, status: value as ReasoningAuditFilter['status'] }))}><SelectTrigger aria-label={t('status')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t('reasoningAuditAllStatuses')}</SelectItem><SelectItem value="in_flight">{t('reasoningAuditInFlight')}</SelectItem><SelectItem value="completed">{t('reasoningAuditCompleted')}</SelectItem><SelectItem value="failed">{t('reasoningAuditFailed')}</SelectItem><SelectItem value="cancelled">{t('reasoningAuditCancelled')}</SelectItem><SelectItem value="interrupted">{t('reasoningAuditInterrupted')}</SelectItem></SelectGroup></SelectContent></Select><Select value={filters.threadId} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, threadId: value }))}><SelectTrigger aria-label={t('reasoningAuditThread')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t('reasoningAuditAllThreads')}</SelectItem><SelectItem value="main">{t('reasoningAuditMainThread')}</SelectItem>{audits.data.threads.map((thread) => <SelectItem key={thread.id} value={thread.id}>{thread.title ?? t('reasoningAuditArchivedThread')}</SelectItem>)}</SelectGroup></SelectContent></Select><Select value={filters.model} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, model: value }))}><SelectTrigger aria-label={t('reasoningAuditModel')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t('reasoningAuditAllModels')}</SelectItem>{audits.data.models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectGroup></SelectContent></Select><Select value={filters.requestKind} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, requestKind: value }))}><SelectTrigger aria-label={t('reasoningAuditKind')}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t('reasoningAuditAllKinds')}</SelectItem>{audits.data.request_kinds.map((kind) => <SelectItem key={kind} value={kind}>{reasoningAuditPurpose(t, kind)}</SelectItem>)}</SelectGroup></SelectContent></Select><Button type="button" variant="outline" onClick={clearFilters}><XIcon data-icon="inline-start" />{t('reasoningAuditClearFilters')}</Button></div></CardContent></Card>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">{range}</p><div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{t('reasoningAuditPageSize')}</span><Select value={String(filters.pageSize)} onValueChange={(value) => setFilters((current) => ({ ...current, page: 1, pageSize: Number(value) }))}><SelectTrigger aria-label={t('reasoningAuditPageSize')} size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="20">20</SelectItem><SelectItem value="50">50</SelectItem><SelectItem value="100">100</SelectItem></SelectGroup></SelectContent></Select>{audits.isFetching && <Spinner />}</div></div>
    {audits.data.items.length === 0 ? <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('reasoningAuditEmpty')}</CardContent></Card> : <Card><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>{t('status')}</TableHead><TableHead>{t('reasoningAuditThread')}</TableHead><TableHead>{t('reasoningAuditKind')}</TableHead><TableHead>{t('reasoningAuditStarted')}</TableHead><TableHead>{t('reasoningAuditFinished')}</TableHead><TableHead>{t('reasoningAuditContext')}</TableHead><TableHead>{t('reasoningAuditUsage')}</TableHead><TableHead>{t('reasoningAuditOpenAiLb')}</TableHead><TableHead>{t('reasoningAuditError')}</TableHead></TableRow></TableHeader><TableBody>{audits.data.items.map((item) => { const status = reasoningAuditStatus(t, item.status); return <TableRow key={item.id}><TableCell><Badge variant={status.variant}>{item.status === 'in_flight' && <Spinner data-icon="inline-start" />}{status.label}</Badge></TableCell><TableCell><AuditThreadLink item={item} /></TableCell><TableCell><div className="flex min-w-32 flex-col gap-1"><span>{reasoningAuditPurpose(t, item.request_kind)}</span><code className="text-xs text-muted-foreground">{item.model}</code></div></TableCell><TableCell><div className="min-w-40"><div>{formatTime(item.started_at)}</div><div className="text-xs text-muted-foreground">{t('duration')}: {duration(item)}</div></div></TableCell><TableCell>{formatTime(item.finished_at)}</TableCell><TableCell><div className="flex min-w-28 flex-col gap-1 text-xs tabular-nums"><span>head #{item.idx_head ?? "—"}</span><span className="text-muted-foreground">tail #{item.idx_tail ?? "—"}</span></div></TableCell><TableCell>{tokenUsage(item)}</TableCell><TableCell>{item.openai_lb_request_id ? <Button asChild size="sm" variant="link"><a href={`https://openai.ntnl.io/#/audit/${encodeURIComponent(item.openai_lb_request_id)}`} target="_blank" rel="noreferrer"><ExternalLinkIcon data-icon="inline-start" />{item.openai_lb_request_id}</a></Button> : '—'}</TableCell><TableCell><span className="block max-w-72 whitespace-normal text-xs text-destructive" title={item.error ?? undefined}>{item.error ?? '—'}</span></TableCell></TableRow> })}</TableBody></Table></CardContent></Card>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{pageLabel}</p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeftIcon data-icon="inline-start" />{t('reasoningAuditPreviousPage')}</Button><Button variant="outline" size="sm" disabled={filters.page >= totalPages} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>{t('reasoningAuditNextPage')}<ChevronRightIcon data-icon="inline-end" /></Button></div></div>
  </Page>
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

function DangerZoneCard({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [error, setError] = useState('')

  const clearConversation = async () => {
    setClearing(true)
    setError('')
    try {
      await api<{ cleared: boolean }>('/api/conversation/clear', token, {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'clear-conversation' }),
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversation'] }),
        queryClient.invalidateQueries({ queryKey: ['threads'] }),
      ])
      queryClient.removeQueries({ queryKey: ['thread'] })
      setCleared(true)
      setOpen(false)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setClearing(false)
    }
  }

  return <Card className="border-destructive/30"><CardHeader><CardTitle className="text-destructive">{t('dangerZoneTitle')}</CardTitle><CardDescription>{t('dangerZoneDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><div className="flex flex-col gap-3"><div><h2 className="font-medium">{t('clearConversation')}</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('clearConversationDescription')}</p></div><Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>{t('clearConversationWarning')}</AlertTitle><AlertDescription>{t('clearConversationPreserved')}</AlertDescription></Alert></div>{cleared && <p className="text-sm font-medium" role="status">{t('conversationCleared')}</p>}{error && <ErrorAlert error={error} />}<Button className="w-fit" variant="destructive" onClick={() => { setError(''); setOpen(true) }}>{t('clearConversation')}</Button><Dialog open={open} onOpenChange={(next) => { if (!clearing) setOpen(next) }}><DialogContent className="sm:max-w-md" showCloseButton={!clearing}><DialogHeader><DialogTitle>{t('clearConversationConfirmTitle')}</DialogTitle><DialogDescription>{t('clearConversationConfirmDescription')}</DialogDescription></DialogHeader><Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>{t('clearConversationWarning')}</AlertTitle><AlertDescription>{t('clearConversationPreserved')}</AlertDescription></Alert>{error && <ErrorAlert error={error} />}<DialogFooter><DialogClose asChild><Button variant="outline" disabled={clearing}>{t('cancel')}</Button></DialogClose><Button variant="destructive" disabled={clearing} onClick={() => void clearConversation()}>{clearing && <Spinner data-icon="inline-start" />}{clearing ? t('clearingConversation') : t('clearConversationConfirm')}</Button></DialogFooter></DialogContent></Dialog></CardContent></Card>
}

function SettingsPage({ token }: { token: AuthMiniApi }) {
  const { t } = useUi()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings', token) })
  const [model, setModel] = useState('')
  const [subthreadModel, setSubthreadModel] = useState('')
  const [voiceScriptModel, setVoiceScriptModel] = useState('')
  const [voiceTurnModel, setVoiceTurnModel] = useState('')
  const [voiceScriptMaxChars, setVoiceScriptMaxChars] = useState(150)
  const [contextWindowLimit, setContextWindowLimit] = useState('')
  const [zhVoice, setZhVoice] = useState('')
  const [enVoice, setEnVoice] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setModel(settings.data?.default_model ?? '')
    setSubthreadModel(settings.data?.subthread_model ?? '')
    setVoiceScriptModel(settings.data?.voice_script_model ?? '')
    setVoiceTurnModel(settings.data?.voice_turn_model ?? '')
    setVoiceScriptMaxChars(settings.data?.voice_script_max_chars ?? 150)
    setContextWindowLimit(settings.data?.context_window_limit?.toString() ?? '')
    setZhVoice(settings.data?.edge_tts_zh_voice ?? '')
    setEnVoice(settings.data?.edge_tts_en_voice ?? '')
    setBaseUrl(settings.data?.openai_base_url ?? '')
    setApiKey(settings.data?.openai_api_key ?? '')
  }, [settings.data])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = await api<Settings>('/api/settings', token, {
        method: 'PUT',
        body: JSON.stringify({ default_model: model, subthread_model: subthreadModel, voice_script_model: voiceScriptModel, voice_turn_model: voiceTurnModel, voice_script_max_chars: voiceScriptMaxChars, context_window_limit: contextWindowLimit.trim() ? Number(contextWindowLimit) : null, edge_tts_zh_voice: zhVoice, edge_tts_en_voice: enVoice, openai_base_url: baseUrl, openai_api_key: apiKey }),
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

  return <Page title={t('settingsTitle')} description={t('settingsDescription')}>
    <Card><CardHeader><CardTitle>{t('settingsTitle')}</CardTitle><CardDescription>{t('controllerDescription')}</CardDescription></CardHeader><CardContent><form className="flex flex-col gap-4" onSubmit={save}><FieldGroup>
      <Field><FieldLabel htmlFor="model">{t('mainThreadModel')}</FieldLabel><Input id="model" value={model} onChange={(event) => setModel(event.target.value)} required /><FieldDescription>{t('mainThreadModelHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="subthread-model">{t('subthreadModel')}</FieldLabel><Input id="subthread-model" value={subthreadModel} onChange={(event) => setSubthreadModel(event.target.value)} required /><FieldDescription>{t('subthreadModelHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="voice-script-model">{t('voiceScriptModel')}</FieldLabel><Input id="voice-script-model" value={voiceScriptModel} onChange={(event) => setVoiceScriptModel(event.target.value)} required /><FieldDescription>{t('voiceScriptModelHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="voice-turn-model">{t('voiceTurnModel')}</FieldLabel><Input id="voice-turn-model" value={voiceTurnModel} onChange={(event) => setVoiceTurnModel(event.target.value)} required /><FieldDescription>{t('voiceTurnModelHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="voice-script-max-chars">{t('voiceScriptLength')}</FieldLabel><Input id="voice-script-max-chars" type="number" min={1} step={1} value={voiceScriptMaxChars} onChange={(event) => setVoiceScriptMaxChars(Number(event.target.value))} required /><FieldDescription>{t('voiceScriptLengthHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="context-window-limit">{t('contextWindowLimit')}</FieldLabel><Input id="context-window-limit" type="number" min={1} step={1} inputMode="numeric" value={contextWindowLimit} onChange={(event) => setContextWindowLimit(event.target.value)} /><FieldDescription>{t('contextWindowLimitHint')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="edge-tts-zh-voice">{t('chineseVoice')}</FieldLabel><Input id="edge-tts-zh-voice" value={zhVoice} onChange={(event) => setZhVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'zh-CN-XiaoxiaoNeural')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="edge-tts-en-voice">{t('englishVoice')}</FieldLabel><Input id="edge-tts-en-voice" value={enVoice} onChange={(event) => setEnVoice(event.target.value)} required /><FieldDescription>{t('edgeVoiceHint').replace('{voice}', 'en-US-JennyNeural')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="openai-base-url">{t('baseUrl')}</FieldLabel><Input id="openai-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /><FieldDescription>{t('baseUrlDescription')}</FieldDescription></Field>
      <Field><FieldLabel htmlFor="openai-api-key">{t('apiKey')}</FieldLabel><Input id="openai-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /><FieldDescription>{t('apiKeyDescription')}</FieldDescription></Field>
    </FieldGroup>{error && <ErrorAlert error={error} />}<Button disabled={saving}>{saving && <Spinner data-icon="inline-start" />}{t('saveChanges')}</Button></form></CardContent></Card>
    <DangerZoneCard token={token} />
    <UpdatesCard token={token} />
  </Page>
}
function Page({ title, description, children }: { title: string; description: string; children: ReactNode }) { return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6"><div><h1 className="font-heading text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>{children}</main> }
function ErrorAlert({ error }: { error: string }) { const { t } = useUi(); return <Alert variant="destructive"><AlertTitle>{t('requestFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> }

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><TooltipProvider><UiProvider><HashRouter><App /></HashRouter></UiProvider></TooltipProvider></QueryClientProvider>)
