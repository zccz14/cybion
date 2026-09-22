import { SlidersHorizontalIcon, ZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

type ThreadSettingsCopyKey = "settings" | "model" | "reasoningEffort" | "fastMode" | "contextBudget" | "contextBudgetHint"

const copy = {
  en: { settings: "Thread settings", model: "Model", reasoningEffort: "Reasoning effort", fastMode: "Fast mode", contextBudget: "Context budget", contextBudgetHint: "Tokens before automatic compaction; empty follows the default." },
  zh: { settings: "线程设置", model: "模型", reasoningEffort: "推理强度", fastMode: "快速模式", contextBudget: "上下文预算", contextBudgetHint: "超过后自动压缩；留空跟随默认值。" },
} satisfies Record<"en" | "zh", Record<ThreadSettingsCopyKey, string>>

export function ThreadSettingsPopover({ model, reasoningEffort, fast, models, language, contextBudget, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  reasoningEffort: string
  fast: boolean
  models: string[]
  language: "en" | "zh"
  contextBudget?: { override: number | null; fallback: number; onChange: (value: number | null) => void }
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
    </PopoverContent>
  </Popover>
}
