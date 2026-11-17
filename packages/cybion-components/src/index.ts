/**
 * What a host may depend on. Three jobs, and nothing else:
 *
 * 1. drop the whole conversation in — `CybionThreadProvider` + `CybionThreadView`;
 * 2. compose your own shell out of the same parts the packaged view uses —
 *    `HistoryMessage`, `ThreadHistory`, the composer widgets, the settings form,
 *    the usage panels;
 * 3. read the wire shapes those parts take.
 *
 * Everything else stays inside the package. Record renderers (one card per tool),
 * the low-level client, the copy dictionary and the transcript/scroll internals
 * are implementation: exporting them froze signatures no host ever called, and
 * every one of them had to keep working forever. `tests/public-api.test.ts`
 * freezes this list, so adding a line here is a deliberate act, not a side effect.
 */
export { CybionThreadProvider } from "./provider"
export type { CybionLink, CybionLinkProps, CybionThreadProviderProps } from "./provider"
export { CybionThreadView } from "./thread-view"
export type { CybionThreadViewProps } from "./thread-view"

// The transcript: one record as the conversation shows it, and the list that
// groups the records into turns.
export { HistoryMessage } from "./components/history-message"
export { ThreadHistory } from "./components/thread-history"
export type { ManualSummary, Worker } from "./components/history-message"
export type { HistoryRecord, ThreadHistoryWindow } from "./lib/thread-history"
export type { ThreadResponseView } from "./lib/thread-response"
export type { ThreadUsage } from "./lib/thread-usage"
export type { ThreadDisplayStatus } from "./lib/thread-status"
export type { ThreadManualLoadsView } from "./lib/thread-manual-loads"
export type { Language, Thread, ThreadDefaults } from "./api"

// Usage, as a row, a panel and a set of rows.
export { ThreadUsagePanel, ThreadUsageSummary, ThreadUsageDetails } from "./components/thread-usage"

// The composer, for a host that lays out its own input row.
export { ComposerAttach } from "./components/composer-attach"
export { ComposerAttachments } from "./components/composer-attachments"
export { ComposerFileNotice, ComposerLengthNotice } from "./components/composer-file-notice"
export { ComposerAudio } from "./components/composer-audio"
export { ComposerAudioNotice } from "./components/composer-audio-notice"
export { ComposerDraftNotice } from "./components/composer-draft-notice"
export { attachComposerAudio } from "./hooks/use-composer-audio"
export { attachComposerImages } from "./hooks/use-composer-images"
export type { ComposerFile, SkippedFile, SkippedFileReason } from "./lib/composer-files"

// The settings form: one control, the two shells over it, and the schema readers
// and writers that let a host hold the value itself.
export { ThreadSettingsFields } from "./components/thread-settings-fields"
export { ThreadSettingsPopover } from "./components/thread-settings-popover"
export { ThreadSettingsButton } from "./components/thread-settings-button"
export { REASONING_EFFORTS, budgetTooLarge, sameThreadSettings, threadSettingsDefaults, threadSettingsForNewThread, threadSettingsFromDefaults, threadSettingsFromThread } from "./lib/thread-settings"
export type { ReasoningEffort, ThreadSettings } from "./lib/thread-settings"
