import { ZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export type ModelCatalog = {
  id: string
  name: string
  models: string[]
  error: string | null
}

type ThreadSettingsCopyKey = "settings" | "model" | "reasoningEffort" | "fastMode" | "contextBudget" | "contextBudgetHint" | "minimalMode" | "minimalModeHint" | "minimalModeDefault" | "minimalModeOn" | "minimalModeOff" | "imageGeneration" | "imageGenerationHint" | "imageGenerationDefault" | "imageGenerationDisabled"

const copy = {
  en: { settings: "Thread settings", model: "Model", reasoningEffort: "Reasoning effort", fastMode: "Fast mode", contextBudget: "Context budget", contextBudgetHint: "Tokens before automatic compaction; empty follows the default.", minimalMode: "Minimal mode", minimalModeHint: "Only the final reply or status of each turn stays open.", minimalModeDefault: "Follow default", minimalModeOn: "On", minimalModeOff: "Off", imageGeneration: "Image generation", imageGenerationHint: "The image model served by this thread's upstream; Disabled turns image generation off.", imageGenerationDefault: "Follow default", imageGenerationDisabled: "Disabled" },
  zh: { settings: "线程设置", model: "模型", reasoningEffort: "推理强度", fastMode: "快速模式", contextBudget: "上下文预算", contextBudgetHint: "超过后自动压缩；留空跟随默认值。", minimalMode: "极简模式", minimalModeHint: "每轮仅展开最后一条回复或状态。", minimalModeDefault: "跟随默认", minimalModeOn: "开启", minimalModeOff: "关闭", imageGeneration: "图像生成", imageGenerationHint: "由该线程的上游提供的图像模型；选择关闭即禁用图像生成。", imageGenerationDefault: "跟随默认", imageGenerationDisabled: "关闭" },
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

// Image generation runs over the Thread's own upstream, so its options are
// that upstream's image catalog; saved values stay selectable even when the
// upstream stops reporting them.
export function imageModelOptions(catalogs: ModelCatalog[] | undefined, upstreamId: string | null, values: (string | null)[]) {
  const groups = (catalogs ?? []).filter((group) => upstreamId === null || group.id === upstreamId)
  const models = new Set<string>()
  for (const group of groups) for (const model of group.models) models.add(model)
  for (const value of values) if (value) models.add(value)
  return [...models]
}

export function ThreadSettingsPopover({ model, upstreamId, catalogs, reasoningEffort, fast, language, contextBudget, minimalMode, imageGeneration, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  upstreamId: string | null
  catalogs: ModelCatalog[] | undefined
  reasoningEffort: string
  fast: boolean
  language: "en" | "zh"
  contextBudget?: { override: number | null; fallback: number; onChange: (value: number | null) => void }
  minimalMode?: { override: boolean | null; fallback: boolean; onChange: (value: boolean | null) => void }
  imageGeneration?: { override: string | null; fallback: string; catalogs: ModelCatalog[] | undefined; onChange: (value: string | null) => void }
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
    <PopoverContent side="top" align="start" className="w-80">
      <div className="flex flex-col gap-2">
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
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label>{t.reasoningEffort}</Label>
          <span data-slot="reasoning-effort-value" className="text-xs text-muted-foreground">{reasoningEffort}</span>
        </div>
        <Slider aria-label={t.reasoningEffort} min={0} max={REASONING_EFFORTS.length - 1} step={1} disabled={disabled} value={[stop]} onValueChange={([value]) => onReasoningChange(REASONING_EFFORTS[value])} />
        <div data-slot="reasoning-effort-scale" className="flex justify-between text-xs text-muted-foreground">{REASONING_EFFORTS.map((item) => <span key={item}>{item}</span>)}</div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5"><ZapIcon className="size-4" />{t.fastMode}</Label>
        <Switch aria-label={t.fastMode} checked={fast} disabled={disabled} onCheckedChange={onFastChange} />
      </div>
      {contextBudget && <div className="flex flex-col gap-2">
        <Label htmlFor="thread-settings-context-budget">{t.contextBudget}</Label>
        <Input
          id="thread-settings-context-budget"
          type="number"
          min={0}
          max={10000000}
          step={1000}
          inputMode="numeric"
          disabled={disabled}
          placeholder={String(contextBudget.fallback)}
          value={contextBudget.override === null ? "" : String(contextBudget.override)}
          onChange={(event) => {
            const raw = event.target.value.trim()
            const parsed = Number(raw)
            contextBudget.onChange(raw === "" || !Number.isFinite(parsed) ? null : parsed)
          }}
        />
        <p className="text-xs text-muted-foreground">{t.contextBudgetHint}</p>
      </div>}
      {minimalMode && <div className="flex flex-col gap-2">
        <Label>{t.minimalMode}</Label>
        <Select value={minimalMode.override === null ? "default" : minimalMode.override ? "on" : "off"} onValueChange={(value) => minimalMode.onChange(value === "default" ? null : value === "on")} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={t.minimalMode}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="default">{`${t.minimalModeDefault} (${minimalMode.fallback ? t.minimalModeOn : t.minimalModeOff})`}</SelectItem>
            <SelectItem value="on">{t.minimalModeOn}</SelectItem>
            <SelectItem value="off">{t.minimalModeOff}</SelectItem>
          </SelectGroup></SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t.minimalModeHint}</p>
      </div>}
      {imageGeneration && <div className="flex flex-col gap-2">
        <Label>{t.imageGeneration}</Label>
        <Select value={imageGeneration.override === null ? "default" : imageGeneration.override === "" ? "off" : imageGeneration.override} onValueChange={(value) => imageGeneration.onChange(value === "default" ? null : value === "off" ? "" : value)} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={t.imageGeneration}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="default">{`${t.imageGenerationDefault} (${imageGeneration.fallback === "" ? t.imageGenerationDisabled : imageGeneration.fallback})`}</SelectItem>
            <SelectItem value="off">{t.imageGenerationDisabled}</SelectItem>
            {imageModelOptions(imageGeneration.catalogs, upstreamId, [imageGeneration.override, imageGeneration.fallback]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t.imageGenerationHint}</p>
      </div>}
    </PopoverContent>
  </Popover>
}
