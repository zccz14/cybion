import type { Language } from "./api"

/**
 * Flat dictionary, both languages in one place: the package ships its own copy so a
 * host app gets a finished thread surface without wiring a translation table.
 */
const copy = {
  loadError: { en: "Could not load this surface", zh: "无法加载这个页面" },
  continueThreadHint: { en: "Continue from saved history without sending a new prompt", zh: "从已有记录继续，不发送新的提示词" },
  stopThreadHint: { en: "Stop reasoning and keep saved records", zh: "停止推理，保留已保存的记录" },
  stopThread: { en: "Stop", zh: "停止" },
  input: { en: "Give this thread its next instruction…", zh: "继续描述你的需求…" },
  send: { en: "Send", zh: "发送" },
  cancel: { en: "Cancel", zh: "取消" },
  stop: { en: "Stop", zh: "停止" },
  continue: { en: "Continue", zh: "继续" },
  continueThread: { en: "Continue", zh: "继续" },
  rename: { en: "Rename", zh: "重命名" },
  generateTitle: { en: "Generate a title from the full conversation", zh: "引用全部重放内容生成标题" },
  threadName: { en: "Thread name", zh: "对话名称" },
  archived: { en: "Archived", zh: "已归档" },
  apiOrigin: { en: "API", zh: "API" },
  apiOriginHint: { en: "Created via the integration API", zh: "由集成 API 创建" },
  compactThread: { en: "Compact", zh: "压缩" },
  compactThreadHint: { en: "Compress manual into a checkpoint and keep the original records", zh: "将重放上下文压缩为检查点，保留原始记录" },
  threadStopped: { en: "Reasoning stopped. Saved records were kept.", zh: "推理已停止，已保存的记录保留。" },
  threadContinued: { en: "Continued without a new prompt.", zh: "已直接继续推理，未发送新提示词。" },
  threadCompactionRequested: { en: "Checkpoint compaction requested.", zh: "已请求压缩重放上下文，生成检查点。" },
  worker: { en: "Worker", zh: "Worker" },
  recordToolOutput: { en: "Worker result", zh: "Worker 结果" },
  recordReasoning: { en: "Reasoning", zh: "推理 (Reasoning)" },
  recordActivity: { en: "Activity", zh: "活动记录" },
  recordBudgetExhausted: { en: "Spend limit reached", zh: "已达花费上限" },
  // The Controller writes this record in English because it is also what the model reads.
  // The panel restates it from the amounts on the record, so the conversation reads in the
  // language the reader picked.
  budgetExhausted: {
    en: "Budget exhausted: {spent} settled of the {budget} limit.",
    zh: "预算已耗尽：已结算 {spent}，上限 {budget}。",
  },
  budgetRaiseHint: {
    en: "Add budget to keep going: the limit becomes the settled spend plus this amount, and the Thread continues.",
    zh: "追加预算即可继续：上限将变为「已结算花费 + 这笔金额」，随后线程继续执行。",
  },
  budgetRaiseLabel: { en: "Budget to add (USD)", zh: "追加预算（USD）" },
  budgetRaiseAction: { en: "Add and continue", zh: "追加并继续" },
  budgetRaiseNewLimit: { en: "New limit: {limit}", zh: "新上限：{limit}" },
  recordContext: { en: "Injected context", zh: "注入的上下文" },
  recordProtocol: { en: "Protocol event", zh: "协议事件" },
  generatedImage: { en: "Generated image", zh: "生成的图片" },
  recordHidden: { en: "Internal", zh: "内部记录" },
  recordPayload: { en: "View raw payload", zh: "查看原始负载" },
  noHistory: { en: "No messages in this thread yet.", zh: "这个线程还没有消息。" },
  safetyWaiting: { en: "Waiting for safety checks", zh: "正在等待安全检查" },
  loadEarlierMessages: { en: "Load earlier messages", zh: "加载更早消息" },
  loadingEarlierMessages: { en: "Loading earlier messages…", zh: "正在加载更早消息…" },
  retry: { en: "Retry", zh: "重试" },
  settings: { en: "Model settings", zh: "模型设置" },
  threadSettings: { en: "Thread settings", zh: "线程设置" },
  model: { en: "Model", zh: "模型" },
  reasoningEffort: { en: "Reasoning effort", zh: "推理强度" },
  fastMode: { en: "Fast mode", zh: "Fast 模式" },
  contextUsage: { en: "Context", zh: "上下文" },
  usage: { en: "Usage", zh: "用量" },
  tokens: { en: "tokens", zh: "tokens" },
  cost: { en: "Cost", zh: "成本" },
  cacheHitRate: { en: "Cache hit rate", zh: "缓存命中率" },
  inputTokens: { en: "Input", zh: "输入" },
  outputTokens: { en: "Output", zh: "输出" },
  cachedTokens: { en: "Cached", zh: "缓存" },
  attachments: { en: "Attach image", zh: "添加图片" },
  contextBudget: { en: "Context budget", zh: "上下文窗口限制" },
  contextBudgetHint: { en: "Tokens before automatic compaction; empty follows the default.", zh: "超过后自动压缩；留空跟随默认值。" },
  usdBudget: { en: "Spend limit (USD)", zh: "花费上限（USD）" },
  usdBudgetTooLarge: { en: "The limit may not exceed $10,000.", zh: "上限不能超过 $10,000。" },
  usdBudgetHint: { en: "The thread stops and waits once its settled spend reaches this amount. Empty follows the default; 0 means no limit.", zh: "已结算花费达到该金额后本线程停止并转入受阻；留空跟随默认值，0 表示不限制。" },
  loadedManualCap: { en: "Loaded manuals", zh: "已加载手册上限" },
  loadedManualCapHint: { en: "Manuals this thread may keep loaded at once; empty follows the default.", zh: "本线程可同时保持加载的手册数；留空跟随默认值。" },
  initialManuals: { en: "Initial manuals", zh: "初始手册" },
  initialManualsHint: { en: "Loaded the moment the thread starts, before its first message. Adding or removing one here loads or releases it now; the model's own loads stay.", zh: "线程一开始就加载，先于第一条消息。在这里添加或移除会立即加载或卸载；模型自己加载的手册不受影响。" },
  initialManualsFollowing: { en: "Following the account default.", zh: "当前跟随账号默认。" },
  initialManualsAdd: { en: "Add a manual…", zh: "添加手册…" },
  initialManualsDefault: { en: "Follow default", zh: "跟随默认" },
  initialManualsEmpty: { en: "No initial manual: a new thread starts empty until you add one.", zh: "还没有初始手册：新线程从空开始，添加一个即可。" },
  initialManualsUnknown: { en: "Unknown manual", zh: "未知手册" },
  initialManualsRemove: { en: "Remove", zh: "移除" },
  minimalMode: { en: "Minimal mode", zh: "极简模式" },
  minimalModeHint: { en: "Only the final reply or status of each turn stays open.", zh: "每轮仅展开最后一条回复或状态。" },
  minimalModeDefault: { en: "Follow default", zh: "跟随默认" },
  minimalModeOn: { en: "On", zh: "开启" },
  minimalModeOff: { en: "Off", zh: "关闭" },
  imageGeneration: { en: "Image generation", zh: "图像生成" },
  imageGenerationHint: { en: "The image model served by this thread's upstream; Disabled turns image generation off.", zh: "由该线程的上游提供的图像模型；选择关闭即禁用图像生成。" },
  imageGenerationDefault: { en: "Follow default", zh: "跟随默认" },
  imageGenerationDisabled: { en: "Disabled", zh: "关闭" },
  audioTranscription: { en: "Speech-to-text", zh: "语音识别" },
  audioTranscriptionHint: { en: "The speech-to-text model behind audio input; Disabled turns audio input off.", zh: "音频输入使用的语音识别模型；选择关闭即禁用音频输入。" },
  audioTranscriptionDefault: { en: "Follow default", zh: "跟随默认" },
  audioTranscriptionDisabled: { en: "Disabled", zh: "关闭" },
  recordAudio: { en: "Record voice", zh: "录制语音" },
  stopRecording: { en: "Stop recording", zh: "结束录音" },
  recording: { en: "Recording…", zh: "正在录音…" },
} as const

export type CopyKey = keyof typeof copy

export function copyFor(language: Language, key: CopyKey): string {
  return copy[key][language]
}

/** A copy line that names values, e.g. the amounts a budget record carries. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match)
}
