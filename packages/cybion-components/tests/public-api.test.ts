import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The published surface, frozen.
 *
 * What matters here is not the count but the *shape* of it: every entry is either
 * a component or a hook that owns its own data flow. A component that renders a
 * form while leaving the reading, diffing and saving to the caller has not
 * encapsulated anything — it published its internals as a to-do list. So the
 * settings surface ships three hooks (`useThreadDefaultsForm`,
 * `useNewThreadSettings`, `useThreadSettingsPanel`) and no writer functions: a
 * host passes a value around and never assembles a payload.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

function exported(source: string) {
  return [...source.matchAll(/export (type )?\{([\s\S]*?)\} from/g)].flatMap(([, isType, names]) =>
    names.split(",").map((part) => part.trim()).filter(Boolean).map((part) => ({ name: part.split(/\s+as\s+/).pop()!.trim(), isType: Boolean(isType) })),
  )
}

const surface = exported(read("../src/index.ts"))
const values = surface.filter((entry) => !entry.isType).map((entry) => entry.name).sort()
const types = surface.filter((entry) => entry.isType).map((entry) => entry.name).sort()

describe("the published surface", () => {
  it("exports components and hooks, in a list short enough to read", () => {
    expect(values).toEqual([
      "ComposerAttach", "ComposerAttachments", "ComposerAudio", "ComposerAudioNotice",
      "ComposerDraftNotice", "ComposerFileNotice", "ComposerLengthNotice", "CybionThreadProvider",
      "CybionThreadView", "HistoryMessage", "REASONING_EFFORTS", "ThreadHistory",
      "ThreadSettingsButton", "ThreadSettingsFields", "ThreadSettingsPopover", "ThreadStatusBadge",
      "ThreadUsageDetails", "ThreadUsagePanel", "ThreadUsageSummary", "attachComposerAudio",
      "attachComposerImages", "audioDraftScope", "cn", "composeComposerInput", "composerAction",
      "composerDraftKey", "emptyThreadUsage", "errorMessage", "formatBytes", "formatRelativeTime",
      "formatStatsDuration", "formattedTime", "handleChatInputKeyDown", "historyPayloadObject",
      "historyPayloadText", "manualLoadNotice", "maxInputChars", "newestRecordId", "oldestRecordId",
      "pendingResponseRecords", "threadStatusLabel", "threadStatusText", "useComposerAttach",
      "useComposerDraft", "useComposerFiles", "useComposerImages", "useNewThreadSettings",
      "useNowSeconds", "useThreadDefaultsForm", "useThreadSettingsPanel",
    ])
  })

  it("carries only the types those components and hooks take or return", () => {
    expect(types).toEqual([
      "AudioTranscriptionFunctionCall", "ComposerFile", "CybionLink", "CybionLinkProps",
      "CybionThreadProviderProps", "CybionThreadViewProps", "HistoryRecord", "Language",
      "ManualSummary", "NewThreadSettings", "ReasoningEffort", "SkippedFile", "SkippedFileReason",
      "Thread", "ThreadDefaults", "ThreadDefaultsForm", "ThreadDisplayStatus", "ThreadHistoryWindow",
      "ThreadManualLoadsView", "ThreadResponseView", "ThreadSettings", "ThreadSettingsPanel",
      "ThreadUsage", "Worker",
    ])
  })

  it("does not publish the algorithm behind a surface", () => {
    // The settings writers and comparators are how the panel works, not what a
    // host wants: exporting them forced every caller to re-run our diff and
    // payload assembly. The hooks own that; the names stay inside the package.
    for (const internal of [
      "threadSettingsFromThread", "threadSettingsFromDefaults", "threadSettingsForNewThread",
      "threadSettingsDefaults", "threadSettingsOverrides", "threadSettingsPatch",
      "sameThreadSettings", "budgetTooLarge", "THREAD_SETTINGS_FIELDS",
      // Record cards, the raw client and the copy table are assembly, not contract.
      "AssistantMessage", "BashCommand", "CybionToolCall", "UserInputMessage", "CybionThreadClient",
      "CybionApiError", "copyFor", "fillCopy", "CopyKey", "useCybion", "groupThreadHistory",
      "pollThreadHistory", "MessageScroller", "UsdBudgetInput",
    ]) {
      expect(values, `${internal} must not be published`).not.toContain(internal)
    }
  })

  it("gives each published surface an owner of its data flow", () => {
    // A form component with no hook beside it is a component that expects the
    // caller to do the work; these three are the whole settings story.
    const hooks = read("../src/hooks/use-thread-settings-form.ts")
    for (const hook of ["useThreadDefaultsForm", "useNewThreadSettings", "useThreadSettingsPanel"]) {
      expect(hooks).toContain(`export function ${hook}(`)
      expect(values).toContain(hook)
    }
    // And the internal entry is where our own app gets everything else.
    expect(read("../src/internal.ts")).toContain("不是包的公开面")
  })
})
