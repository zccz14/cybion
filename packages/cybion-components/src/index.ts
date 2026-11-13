export { CybionThreadClient, CybionApiError } from "./api"
export type {
  CybionClientOptions, CybionTokenProvider, HistoryWindow, Language, RequestAck,
  Thread, ThreadDefaults, UpstreamCatalog, UpstreamModels,
} from "./api"
export { CybionThreadProvider, useCybion } from "./provider"
export type { CybionLink, CybionLinkProps, CybionThreadProviderProps } from "./provider"
export { CybionThreadView } from "./thread-view"
export type { CybionThreadViewProps } from "./thread-view"
export { attachComposerAudio } from "./hooks/use-composer-audio"
export { attachComposerImages } from "./hooks/use-composer-images"
export { HistoryMessage } from "./components/history-message"
export type { ManualSummary, Worker } from "./components/history-message"
export { threadImage } from "./lib/thread-history"
export type { HistoryRecord, ThreadHistoryEntry, ThreadHistoryWindow, ThreadImage } from "./lib/thread-history"
export type { ThreadResponseView } from "./lib/thread-response"
export type { ThreadUsage } from "./lib/thread-usage"
export type { ThreadDisplayStatus } from "./lib/thread-status"
export { copyFor } from "./copy"
export type { CopyKey } from "./copy"
export { ThreadHistory } from "./components/thread-history"

// The transcript's own logic, exported so a host can decide what folds into a
// process group, where that group's spend sits, and which record a history page
// starts from — without keeping a second copy of any of it.
export {
  attachThreadProcessSpend, formatThreadProcessDuration, formatThreadProcessSpend, groupThreadHistory,
  groupThreadHistoryMinimal, inFlightCallIds, isControllerNotice, isRestartNotice, isRetryNotice,
  liveThreadProcessKey, loadedThreadRecords, newestRecordId, oldestRecordId, pollThreadHistory,
  recordInFlight, threadHistoryRecordKey, threadProcessDuration,
} from "./lib/thread-history"
export { isManualNotice, manualLoadNotice } from "./lib/thread-manual-loads"
export type { ThreadManualLoadsView } from "./lib/thread-manual-loads"
export { ThreadUsagePanel, ThreadContextUsage, ThreadUsageSummary, ThreadUsageDetails } from "./components/thread-usage"
export { ThreadStatusSummary, ThreadStatusBadge } from "./components/thread-status"

// Hosts that compose their own list, composer and settings pages need the same
// widgets the packaged view uses, so they import them instead of copying them.
export { ComposerAttachments } from "./components/composer-attachments"
export { ComposerAudio } from "./components/composer-audio"
export { ComposerAudioNotice } from "./components/composer-audio-notice"
export { ComposerDraftNotice } from "./components/composer-draft-notice"
export { ThreadSettingsPopover, imageModelOptions, modelGroups, modelSelection, parseModelSelection } from "./components/thread-settings-popover"
export { WorkerCallSummary } from "./components/worker-call-summary"

// Record renderers, exported so a host can compose its own transcript instead of
// taking the whole view, and so tests can exercise them one by one.
export { AssistantMessage } from "./components/assistant-message"
export { CopyReplyButton } from "./components/copy-reply-button"
export { AudioMessage } from "./components/audio-message"
export { UserInputMessage } from "./components/user-input-message"
export { CheckpointMessage } from "./components/checkpoint-message"
export { BashCommand } from "./components/bash-command"
export { WebSearchCall } from "./components/web-search-call"
export { ImageGenerationCall } from "./components/image-generation-call"
export { BrowserControlCall } from "./components/browser-control-call"
export { ComputerUseCall } from "./components/computer-use-call"
export { ViewImageCall } from "./components/view-image-call"
export { ScreenshotOutput } from "./components/screenshot-output"
export { ViewedOutput } from "./components/viewed-output"
export { ManualLoadNotice } from "./components/manual-load-notice"
export { HistoryRecordPayload } from "./components/history-record-payload"
export { CybionToolCall } from "./components/cybion-tool-call"
export { ThreadImageGroup } from "./components/thread-image-group"
export {
  MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem,
  MessageScrollerProvider, MessageScrollerViewport,
} from "./ui/message-scroller"
export { ThreadProcessGroup } from "./components/thread-process-group"
