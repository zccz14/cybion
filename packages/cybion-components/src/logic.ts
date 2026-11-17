// The framework-free half of the package: parsing, formatting, grouping and the
// composer hooks, with no components and therefore no stylesheet imports. A host
// that keeps its own shell imports these from `@zccz14/cybion-components/logic`,
// so it never has to copy the modules into its own tree.
//
// INVARIANT: every name is listed one by one; this file never `export *`s. A
// barrel that re-exports whole modules silently turns each internal helper into a
// promise the package cannot take back — a signature nobody outside asked for
// still cannot change. What is named here is what a host may rely on; everything
// else stays reachable inside the package (`../lib/...`) and is free to change.
// `tests/public-api.test.ts` freezes exactly this list.

// One Thread's settings: the schema, how to read it from each source, and the
// writers for both endpoints.
export {
  REASONING_EFFORTS, budgetTooLarge, sameThreadSettings, threadSettingsDefaults,
  threadSettingsForNewThread, threadSettingsFromDefaults, threadSettingsFromThread,
} from "./lib/thread-settings"
export type { ReasoningEffort, ThreadSettings } from "./lib/thread-settings"

// The transcript, as far as a host's own chrome needs to know it: which record a
// page starts or ends at, what a payload says, and what a status reads as.
export { newestRecordId, oldestRecordId } from "./lib/thread-history"
export type { HistoryRecord, ThreadHistoryWindow } from "./lib/thread-history"
export { historyPayloadObject, historyPayloadText } from "./lib/history-payload"
export type { AudioTranscriptionFunctionCall } from "./lib/history-payload"
export { pendingResponseRecords } from "./lib/thread-response"
export type { ThreadResponseView } from "./lib/thread-response"
export { threadStatusLabel, threadStatusText } from "./lib/thread-status"
export type { ThreadDisplayStatus } from "./lib/thread-status"
export { emptyThreadUsage } from "./lib/thread-usage"
export type { ThreadUsage } from "./lib/thread-usage"
export { manualLoadNotice } from "./lib/thread-manual-loads"
export type { ThreadManualLoadsView } from "./lib/thread-manual-loads"

// The composer a host drives itself: the same draft, attachment and audio rules
// the packaged view follows.
export { composerAction, handleChatInputKeyDown } from "./lib/chat-input"
export { composerDraftKey } from "./lib/composer-drafts"
export { composeComposerInput, maxInputChars } from "./lib/composer-files"
export { audioDraftScope } from "./lib/composer-audio-drafts"
export { useComposerAttach } from "./hooks/use-composer-attach"
export { attachComposerAudio, useComposerAudio } from "./hooks/use-composer-audio"
export { useComposerDraft } from "./hooks/use-composer-draft"
export { useComposerFiles } from "./hooks/use-composer-files"
export { attachComposerImages, useComposerImages } from "./hooks/use-composer-images"

// The parsers each record card is asserted through: a host that renders its own
// cards reads the same payloads with the same rules.
export {
  audioTranscriptionFunctionCall, bashCallCountdown, bashFunctionCall, browserControlFunctionCall,
  computerUseFunctionCall, cybionToolFunctionCall, imageGenerationFunctionCall, screenshotImageSource,
  userInputView, viewImageFunctionCall, viewedImageSource, webSearchFunctionCall,
} from "./lib/history-payload"
export { audioDurationLabel } from "./lib/composer-audio"
export { compactTokenCount, threadCacheRate, threadCost } from "./lib/thread-usage"
export { threadControlAction } from "./lib/thread-response"
export { threadImage } from "./lib/thread-history"
export { pastedImageFiles } from "./lib/composer-images"
export { splitPickedFiles } from "./lib/composer-files"
export { removeSubmittedDraft } from "./lib/composer-drafts"

// Display helpers, so a host's own rows read exactly like the package's.
export { formatBytes } from "./lib/format"
export { formatRelativeTime, formatStatsDuration, formattedTime } from "./lib/time"
export { useNowSeconds } from "./hooks/use-now"
export { cn, errorMessage } from "./lib/utils"
