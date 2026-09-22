import { SlidersHorizontalIcon, ZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

type ThreadSettingsCopyKey = "settings" | "model" | "reasoningEffort" | "fastMode"

const copy = {
  en: { settings: "Thread settings", model: "Model", reasoningEffort: "Reasoning effort", fastMode: "Fast mode" },
  zh: { settings: "线程设置", model: "模型", reasoningEffort: "推理强度", fastMode: "快速模式" },
} satisfies Record<"en" | "zh", Record<ThreadSettingsCopyKey, string>>

export function ThreadSettingsPopover({ model, reasoningEffort, fast, models, language, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  reasoningEffort: string
  fast: boolean
  models: string[]
  language: "en" | "zh"
  disabled?: boolean
  onModelChange: (model: string) => void
  onReasoningChange: (effort: ReasoningEffort) => void
  onFastChange: (fast: boolean) => void
}) {
  const t = copy[language]
  const stop = Math.max(0, REASONING_EFFORTS.indexOf(reasoningEffort as ReasoningEffort))
  return <Popover>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" size="icon" aria-label={t.settings} title={t.settings} disabled={disabled}><SlidersHorizontalIcon /></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-80">
      <div className="flex flex-col gap-2">
        <Label>{t.model}</Label>
        <Select value={model} onValueChange={onModelChange} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={t.model}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{models.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectGroup></SelectContent>
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
    </PopoverContent>
  </Popover>
}
