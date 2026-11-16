import { ZapIcon } from "lucide-react"

import type { ManualChoice, ModelCatalog } from "../lib/model-catalog"
import { imageModelOptions, modelGroups, modelSelection, parseModelSelection } from "../lib/model-catalog"
import { copyFor } from "../copy"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ThreadSettingsFields, type ReasoningEffort } from "./thread-settings-fields"

export type { ManualChoice, ModelCatalog } from "../lib/model-catalog"
export { imageModelOptions, modelGroups, modelSelection, parseModelSelection } from "../lib/model-catalog"
export type { ReasoningEffort } from "./thread-settings-fields"

/**
 * The composer's thread settings, as a popover. It owns only the trigger and the
 * shell: every field comes from `ThreadSettingsFields`, which the account
 * defaults form renders too, so a setting added once shows up in both places and
 * the two can never disagree about what a field means.
 *
 * Each setting may be left alone (`override: null`), in which case the Thread
 * follows the account default shown as `fallback`.
 */
export function ThreadSettingsPopover({ model, upstreamId, catalogs, reasoningEffort, fast, language, contextBudget, usdBudget, loadedManualCap, initialManuals, minimalMode, imageGeneration, audioTranscription, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  upstreamId: string | null
  catalogs: ModelCatalog[] | undefined
  reasoningEffort: string
  fast: boolean
  language: "en" | "zh"
  contextBudget: { override: number | null; fallback: number; onChange: (value: number | null) => void }
  usdBudget?: { override: number | null; fallback: number; onChange: (value: number | null) => void }
  loadedManualCap: { override: number | null; fallback: number; onChange: (value: number | null) => void }
  /// The Manuals this Thread starts with: its own list, or the account default
  /// it follows when `override` is null. Changing the list binds what it gained
  /// and releases what it lost, so the Thread holds what the setting promises.
  initialManuals: { override: string[] | null; fallback: string[]; catalogs: ManualChoice[] | undefined; onChange: (value: string[] | null) => void }
  minimalMode: { override: boolean | null; fallback: boolean; onChange: (value: boolean | null) => void }
  imageGeneration: { override: string | null; fallback: string; catalogs: ModelCatalog[] | undefined; onChange: (value: string | null) => void }
  audioTranscription: { override: string | null; fallback: string | null; catalogs: ModelCatalog[] | undefined; onChange: (value: string | null) => void }
  disabled?: boolean
  onModelChange: (upstreamId: string, model: string) => void
  onReasoningChange: (effort: ReasoningEffort) => void
  onFastChange: (fast: boolean) => void
}) {
  const settings = copyFor(language, "threadSettings")
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" className="min-w-0 shrink gap-0" aria-label={`${settings}: ${model} (${reasoningEffort})`} title={settings} disabled={disabled}><span className="truncate">{model}</span><span className="whitespace-pre"> ({reasoningEffort})</span></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto overscroll-contain">
      <ThreadSettingsFields
        mode="override"
        idPrefix="thread-settings"
        language={language}
        disabled={disabled}
        catalogs={catalogs}
        model={model}
        upstreamId={upstreamId}
        reasoningEffort={reasoningEffort}
        fast={fast}
        contextBudget={{ value: contextBudget.override, fallback: contextBudget.fallback, onChange: contextBudget.onChange }}
        usdBudget={usdBudget && { value: usdBudget.override, fallback: usdBudget.fallback, onChange: usdBudget.onChange }}
        loadedManualCap={{ value: loadedManualCap.override, fallback: loadedManualCap.fallback, onChange: loadedManualCap.onChange }}
        initialManuals={{ value: initialManuals.override, fallback: initialManuals.fallback, catalogs: initialManuals.catalogs, onChange: initialManuals.onChange }}
        minimalMode={{ value: minimalMode.override, fallback: minimalMode.fallback, onChange: minimalMode.onChange }}
        imageGeneration={{ value: imageGeneration.override, fallback: imageGeneration.fallback, catalogs: imageGeneration.catalogs, onChange: imageGeneration.onChange }}
        audioTranscription={{ value: audioTranscription.override, fallback: audioTranscription.fallback, catalogs: audioTranscription.catalogs, onChange: audioTranscription.onChange }}
        onModelChange={onModelChange}
        onReasoningChange={onReasoningChange}
        onFastChange={onFastChange}
      />
    </PopoverContent>
  </Popover>
}

export const fastModeIcon = ZapIcon
