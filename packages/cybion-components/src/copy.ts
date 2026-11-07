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
  recordAudio: { en: "Record voice", zh: "录制语音" },
  stopRecording: { en: "Stop recording", zh: "结束录音" },
  recording: { en: "Recording…", zh: "正在录音…" },
} as const

export type CopyKey = keyof typeof copy

export function copyFor(language: Language, key: CopyKey): string {
  return copy[key][language]
}
