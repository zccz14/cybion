/**
 * 纯逻辑（无组件、无样式表）。
 *
 * 存在的理由只有一个：有一批用例断言的是解析与换算本身，它们跑在 Node 里，
 * 不能把组件（及其 CSS）拖进来。这里因此只放不渲染任何东西的名字。
 *
 * 它不是第二个公开面——宿主从 `index.ts` 取组件与钩子。这里的内容随内部实现
 * 一起演进，需要时随时可改。
 */
export { REASONING_EFFORTS } from "./lib/thread-settings"
export type { ReasoningEffort, ThreadSettings } from "./lib/thread-settings"
export { newestRecordId, oldestRecordId, threadImage } from "./lib/thread-history"
export type { HistoryRecord, ThreadHistoryWindow } from "./lib/thread-history"
export {
  audioTranscriptionFunctionCall, bashCallCountdown, bashFunctionCall, browserControlFunctionCall,
  computerUseFunctionCall, cybionToolFunctionCall, historyPayloadObject, historyPayloadText,
  imageGenerationFunctionCall, screenshotImageSource, userInputView, viewImageFunctionCall,
  viewedImageSource, webSearchFunctionCall,
} from "./lib/history-payload"
export type { AudioTranscriptionFunctionCall } from "./lib/history-payload"
export { pendingResponseRecords, threadControlAction } from "./lib/thread-response"
export type { ThreadResponseView } from "./lib/thread-response"
export { threadStatusLabel, threadStatusText } from "./lib/thread-status"
export type { ThreadDisplayStatus } from "./lib/thread-status"
export { compactTokenCount, emptyThreadUsage, threadCacheRate, threadCost } from "./lib/thread-usage"
export type { ThreadUsage } from "./lib/thread-usage"
export { manualLoadNotice } from "./lib/thread-manual-loads"
export type { ThreadManualLoadsView } from "./lib/thread-manual-loads"
export { audioDurationLabel } from "./lib/composer-audio"
export { composerAction, handleChatInputKeyDown } from "./lib/chat-input"
export { composerDraftKey, removeSubmittedDraft } from "./lib/composer-drafts"
export { composeComposerInput, maxInputChars, splitPickedFiles } from "./lib/composer-files"
export { pastedImageFiles } from "./lib/composer-images"
export { audioDraftScope } from "./lib/composer-audio-drafts"
export { formatBytes } from "./lib/format"
export { formatRelativeTime, formatStatsDuration, formattedTime } from "./lib/time"
export { cn, errorMessage } from "./lib/utils"
