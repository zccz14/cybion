/**
 * The published contract.
 *
 * Two ways in, and neither one hands the host an algorithm:
 *
 * 1. **embed a whole Thread** — `CybionThreadProvider` + `CybionThreadView`;
 * 2. **build a screen out of the same parts** — the transcript rows, the composer
 *    widgets, and the settings surface, each of which comes with the hook that
 *    owns its data flow.
 *
 * The second point is the one that keeps changing: a component that renders a
 * form but leaves the reading, diffing and saving to the caller has not
 * encapsulated anything — it has published its internals as a to-do list. So
 * every surface that needs data ships a hook that does that work (`useThreadDefaultsForm`,
 * `useNewThreadSettings`, `useThreadSettingsPanel`) and the host only passes the
 * value around.
 *
 * `tests/public-api.test.ts` freezes this list.
 */
export { CybionThreadProvider } from "./provider"
export { CybionThreadView } from "./thread-view"
export type { CybionLink, CybionLinkProps, CybionThreadProviderProps } from "./provider"
export type { CybionThreadSource, CybionThreadSummary, CybionThreadViewProps } from "./thread-view"

// The transcript.
export { HistoryMessage } from "./components/history-message"
export { ThreadHistory } from "./components/thread-history"
export { ThreadUsagePanel, ThreadUsageSummary, ThreadUsageDetails } from "./components/thread-usage"
export { ThreadStatusBadge } from "./components/thread-status"

// The composer, for a host that lays out its own input row.
export { ComposerAttach } from "./components/composer-attach"
export { ComposerAttachments } from "./components/composer-attachments"
export { ComposerFileNotice, ComposerLengthNotice } from "./components/composer-file-notice"
export { ComposerAudio } from "./components/composer-audio"
export { ComposerAudioNotice } from "./components/composer-audio-notice"
export { ComposerDraftNotice } from "./components/composer-draft-notice"
export { attachComposerAudio } from "./hooks/use-composer-audio"
export { attachComposerImages } from "./hooks/use-composer-images"
export { useComposerAttach } from "./hooks/use-composer-attach"
export { useComposerDraft } from "./hooks/use-composer-draft"
export { useComposerFiles } from "./hooks/use-composer-files"
export { useComposerImages } from "./hooks/use-composer-images"
export type { ComposerFile, SkippedFile, SkippedFileReason } from "./lib/composer-files"

// The settings surface: three components, three hooks, and the value they all
// pass around. The host never converts, diffs or assembles a payload itself.
export { ThreadSettingsFields } from "./components/thread-settings-fields"
export { ThreadSettingsPopover } from "./components/thread-settings-popover"
export { ThreadSettingsButton } from "./components/thread-settings-button"
export { useThreadDefaultsForm, useNewThreadSettings, useThreadSettingsPanel } from "./hooks/use-thread-settings-form"
export type { ThreadDefaultsForm, NewThreadSettings, ThreadSettingsPanel } from "./hooks/use-thread-settings-form"
export type { ReasoningEffort, ThreadSettings } from "./lib/thread-settings"
export { REASONING_EFFORTS } from "./lib/thread-settings"

// The wire shapes the props and hooks carry.
export type { Language, Thread, ThreadDefaults } from "./api"
export type { HistoryRecord, ThreadHistoryWindow } from "./lib/thread-history"
export type { ManualSummary, Worker } from "./components/history-message"
export type { ThreadDisplayStatus } from "./lib/thread-status"
export type { ThreadResponseView } from "./lib/thread-response"
export type { ThreadUsage } from "./lib/thread-usage"
export type { ThreadManualLoadsView } from "./lib/thread-manual-loads"
export { manualLoadNotice } from "./lib/thread-manual-loads"
export { newestRecordId, oldestRecordId } from "./lib/thread-history"
export { pendingResponseRecords } from "./lib/thread-response"
export { historyPayloadObject, historyPayloadText } from "./lib/history-payload"
export type { AudioTranscriptionFunctionCall } from "./lib/history-payload"
export { threadStatusLabel, threadStatusText } from "./lib/thread-status"
export { emptyThreadUsage } from "./lib/thread-usage"
export { composerAction, handleChatInputKeyDown } from "./lib/chat-input"
export { composerDraftKey } from "./lib/composer-drafts"
export { composeComposerInput, maxInputChars } from "./lib/composer-files"
export { audioDraftScope } from "./lib/composer-audio-drafts"
export { formatBytes } from "./lib/format"
export { formatRelativeTime, formatStatsDuration, formattedTime } from "./lib/time"
export { useNowSeconds } from "./hooks/use-now"
export { cn, errorMessage } from "./lib/utils"
