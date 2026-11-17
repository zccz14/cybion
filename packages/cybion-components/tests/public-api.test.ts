import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The public surface, frozen.
 *
 * Every name exported from `index.ts` and `logic.ts` is a promise: once a host
 * imports it, its shape cannot change without a major release. So the value of
 * these two lists is what they *omit* — the record cards, the low-level client,
 * the copy dictionary and the transcript internals stay inside the package and
 * remain free to change. Adding a line here is a deliberate act.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

function exported(source: string) {
  return [...source.matchAll(/export (?:type )?\{([\s\S]*?)\} from/g)]
    .flatMap(([, names]) => names.split(",").map((part) => part.trim()).filter(Boolean))
    .map((part) => part.split(/\s+as\s+/).pop()!.trim())
    .sort()
}

const index = exported(read("../src/index.ts"))
const logic = exported(read("../src/logic.ts"))

describe("the package's public surface", () => {
  it("exports exactly what a host needs to embed or compose a Thread", () => {
    expect(index).toEqual([
      "ComposerAttach", "ComposerAttachments", "ComposerAudio", "ComposerAudioNotice",
      "ComposerDraftNotice", "ComposerFile", "ComposerFileNotice", "ComposerLengthNotice",
      "CybionLink", "CybionLinkProps", "CybionThreadProvider", "CybionThreadProviderProps",
      "CybionThreadView", "CybionThreadViewProps", "HistoryMessage", "HistoryRecord",
      "Language", "ManualSummary", "REASONING_EFFORTS", "ReasoningEffort", "SkippedFile",
      "SkippedFileReason", "Thread", "ThreadDefaults", "ThreadDisplayStatus", "ThreadHistory",
      "ThreadHistoryWindow", "ThreadManualLoadsView", "ThreadResponseView", "ThreadSettings",
      "ThreadSettingsButton", "ThreadSettingsFields", "ThreadSettingsPopover", "ThreadUsage",
      "ThreadUsageDetails", "ThreadUsagePanel", "ThreadUsageSummary", "Worker",
      "attachComposerAudio", "attachComposerImages", "budgetTooLarge", "sameThreadSettings",
      "threadSettingsDefaults", "threadSettingsForNewThread", "threadSettingsFromDefaults",
      "threadSettingsFromThread",
    ])
  })

  it("exports exactly the framework-free half a host's own shell needs", () => {
    expect(logic).toEqual([
      "AudioTranscriptionFunctionCall", "HistoryRecord", "REASONING_EFFORTS", "ReasoningEffort",
      "ThreadDisplayStatus", "ThreadHistoryWindow", "ThreadManualLoadsView", "ThreadResponseView",
      "ThreadSettings", "ThreadUsage", "attachComposerAudio", "attachComposerImages",
      "audioDraftScope", "audioDurationLabel", "audioTranscriptionFunctionCall",
      "bashCallCountdown", "bashFunctionCall", "browserControlFunctionCall", "budgetTooLarge",
      "cn", "compactTokenCount", "composeComposerInput", "composerAction", "composerDraftKey",
      "computerUseFunctionCall", "cybionToolFunctionCall", "emptyThreadUsage", "errorMessage",
      "formatBytes", "formatRelativeTime", "formatStatsDuration", "formattedTime",
      "handleChatInputKeyDown", "historyPayloadObject", "historyPayloadText",
      "imageGenerationFunctionCall", "manualLoadNotice", "maxInputChars", "newestRecordId",
      "oldestRecordId", "pastedImageFiles", "pendingResponseRecords", "removeSubmittedDraft",
      "sameThreadSettings", "screenshotImageSource", "splitPickedFiles", "threadCacheRate",
      "threadControlAction", "threadCost", "threadImage", "threadSettingsDefaults",
      "threadSettingsForNewThread", "threadSettingsFromDefaults", "threadSettingsFromThread",
      "threadStatusLabel", "threadStatusText", "useComposerAttach", "useComposerAudio",
      "useComposerDraft", "useComposerFiles", "useComposerImages", "useNowSeconds",
      "userInputView", "viewImageFunctionCall", "viewedImageSource", "webSearchFunctionCall",
    ].sort())
  })

  it("keeps the record cards, the raw client and the copy table inside the package", () => {
    // One card per tool is how the transcript is *assembled*, not what a host
    // composes; exporting them froze 20 signatures nobody called.
    for (const internal of [
      "AssistantMessage", "AudioMessage", "BashCommand", "BrowserControlCall", "CheckpointMessage",
      "ComputerUseCall", "CopyReplyButton", "CybionToolCall", "HistoryRecordPayload",
      "ImageGenerationCall", "ManualLoadNotice", "ScreenshotOutput", "ThreadImageGroup",
      "ThreadProcessGroup", "UserInputMessage", "ViewImageCall", "ViewedOutput",
      "WebSearchCall", "WorkerCallSummary", "CybionThreadClient", "CybionApiError", "copyFor",
      "fillCopy", "CopyKey", "useCybion", "groupThreadHistory", "pollThreadHistory",
      "MessageScroller", "UsdBudgetInput",
    ]) {
      expect(index, `${internal} must not be public`).not.toContain(internal)
      expect(logic, `${internal} must not be public`).not.toContain(internal)
    }
  })

  it("keeps the internal entries explicitly out of the public story", () => {
    // The two internal entries exist only so repository tests and walkthrough
    // pages can render cards; each says so where a maintainer will look.
    expect(read("../src/internal.ts")).toContain("不是包的公开面")
    const readme = read("../README.md")
    expect(readme).not.toContain("`BashCommand`")
    expect(readme).not.toContain("`CybionThreadClient`")
    expect(readme).toContain("`@zccz14/cybion-components/logic`")
    expect(readme).toContain("`@zccz14/cybion-components/styles.css`")
  })
})
