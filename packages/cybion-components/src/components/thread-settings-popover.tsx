import { ZapIcon } from "lucide-react"
import { Button } from "../ui/button"
import { Label } from "../ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { Switch } from "../ui/switch"

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export type ModelCatalog = {
  id: string
  name: string
  models: string[]
  error: string | null
}

type ThreadSettingsCopyKey = "settings" | "model" | "reasoningEffort" | "fastMode"

const copy = {
  en: { settings: "Thread settings", model: "Model", reasoningEffort: "Reasoning effort", fastMode: "Fast mode" },
  zh: { settings: "线程设置", model: "模型", reasoningEffort: "推理强度", fastMode: "快速模式" },
} satisfies Record<"en" | "zh", Record<ThreadSettingsCopyKey, string>>

// A model is chosen as an upstream/model pair; the encoded value keeps the two
// entries apart even when two upstreams report the same model id.
export function modelSelection(upstreamId: string | null, model: string) {
  return upstreamId ? `${upstreamId}:${model}` : ""
}

export function parseModelSelection(value: string) {
  const index = value.indexOf(":")
  return { upstreamId: value.slice(0, index), model: value.slice(index + 1) }
}

// Each upstream owns its catalog, but a thread saved earlier must stay
// selectable even after its upstream stops reporting the model.
export function modelGroups(catalogs: ModelCatalog[] | undefined, upstreamId: string | null, model: string) {
  const groups = catalogs ?? []
  if (!upstreamId) return groups
  if (groups.some((group) => group.id === upstreamId)) {
    return groups.map((group) => group.id === upstreamId && !group.models.includes(model) ? { ...group, models: [model, ...group.models] } : group)
  }
  return [...groups, { id: upstreamId, name: "", models: [model], error: null }]
}

/// The Thread's one settings surface: the new-Thread composer and the
/// conversation render this same picker with the same behaviour, so a setting
/// means the same thing wherever it is shown. What a Thread starts from beyond
/// its model — budgets, gates, tools, Manuals — follows the account defaults
/// instead of being offered twice with two different shapes.
export function ThreadSettingsPopover({ model, upstreamId, catalogs, reasoningEffort, fast, language, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  upstreamId: string | null
  catalogs: ModelCatalog[] | undefined
  reasoningEffort: string
  fast: boolean
  language: "en" | "zh"
  disabled?: boolean
  onModelChange: (upstreamId: string, model: string) => void
  onReasoningChange: (effort: ReasoningEffort) => void
  onFastChange: (fast: boolean) => void
}) {
  const t = copy[language]
  const stop = Math.max(0, REASONING_EFFORTS.indexOf(reasoningEffort as ReasoningEffort))
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" className="min-w-0 shrink gap-0" aria-label={`${t.settings}: ${model} (${reasoningEffort})`} title={t.settings} disabled={disabled}><span className="truncate">{model}</span><span className="whitespace-pre"> ({reasoningEffort})</span></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto overscroll-contain">
      <div className="flex shrink-0 flex-col gap-2">
        <Label>{t.model}</Label>
        <Select value={modelSelection(upstreamId, model)} onValueChange={(value) => { const parsed = parseModelSelection(value); onModelChange(parsed.upstreamId, parsed.model) }} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={t.model}><SelectValue placeholder={model} /></SelectTrigger>
          <SelectContent>{modelGroups(catalogs, upstreamId, model).map((group) => (
            <SelectGroup key={group.id}>
              {group.name && <SelectLabel>{group.name}</SelectLabel>}
              {group.models.map((item) => <SelectItem key={`${group.id}:${item}`} value={`${group.id}:${item}`}>{item}</SelectItem>)}
              {group.error && <SelectLabel className="text-destructive">{group.error}</SelectLabel>}
            </SelectGroup>
          ))}</SelectContent>
        </Select>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>{t.reasoningEffort}</Label>
          <span data-slot="reasoning-effort-value" className="text-xs text-muted-foreground">{reasoningEffort}</span>
        </div>
        <Slider aria-label={t.reasoningEffort} min={0} max={REASONING_EFFORTS.length - 1} step={1} disabled={disabled} value={[stop]} onValueChange={([value]) => onReasoningChange(REASONING_EFFORTS[value])} />
        <div data-slot="reasoning-effort-scale" className="flex justify-between text-xs text-muted-foreground">{REASONING_EFFORTS.map((item) => <span key={item}>{item}</span>)}</div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5"><ZapIcon className="size-4" />{t.fastMode}</Label>
        <Switch aria-label={t.fastMode} checked={fast} disabled={disabled} onCheckedChange={onFastChange} />
      </div>
    </PopoverContent>
  </Popover>
}
