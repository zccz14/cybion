import { ZapIcon } from "lucide-react"

import type { ThreadSettings } from "../lib/thread-settings"
import { copyFor } from "../copy"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ThreadSettingsFields } from "./thread-settings-fields"

export type { ManualChoice, ModelCatalog } from "../lib/model-catalog"
export { imageModelOptions, modelGroups, modelSelection, parseModelSelection } from "../lib/model-catalog"
export type { ReasoningEffort } from "../lib/thread-settings"
export { REASONING_EFFORTS } from "../lib/thread-settings"

/**
 * The same settings control, folded into a popover over the composer.
 *
 * It owns only the trigger and the shell: every field comes from
 * `ThreadSettingsFields`, which the account defaults form and a Thread's own
 * panel render too, so the three surfaces cannot disagree about a field. Pass the
 * value you are editing and take the next one back — where it is saved stays the
 * caller's business.
 */
export function ThreadSettingsPopover({ value, onChange, language, disabled }: {
  value: ThreadSettings
  onChange: (value: ThreadSettings) => void
  language: "en" | "zh"
  disabled?: boolean
}) {
  const settings = copyFor(language, "threadSettings")
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" className="min-w-0 shrink gap-0" aria-label={`${settings}: ${value.model} (${value.reasoning_effort})`} title={settings} disabled={disabled}><span className="truncate">{value.model}</span><span className="whitespace-pre"> ({value.reasoning_effort})</span></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto overscroll-contain">
      <ThreadSettingsFields mode="override" idPrefix="thread-settings" value={value} onChange={onChange} language={language} disabled={disabled} />
    </PopoverContent>
  </Popover>
}

export const fastModeIcon = ZapIcon
