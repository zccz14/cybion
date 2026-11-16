import { XIcon, ZapIcon } from "lucide-react"

import { imageModelOptions, modelGroups, modelSelection, parseModelSelection, type ManualChoice, type ModelCatalog } from "../lib/model-catalog"
import { copyFor, type CopyKey } from "../copy"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { Switch } from "../ui/switch"
import { MAX_BUDGET_USD_NANOS } from "../lib/budget-stop"
import { UsdBudgetInput } from "./usd-budget-input"

/// The select value that means "leave this alone"; display text changes with the
/// language, so it must never be the value itself.
const FOLLOW_DEFAULT = "\u0000default"

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/// One setting that a Thread may leave alone: `null` follows the account default
/// the panel shows as `fallback`. A defaults form passes a concrete value for
/// both, and `mode="defaults"` then drops the "follow default" affordances.
export type ThreadSettingsValue<T> = { value: T | null; fallback: T; onChange: (value: T | null) => void }

/// A setting whose value names a model: the picker also needs the catalogs.
export type ModelSettingValue<T> = ThreadSettingsValue<T> & { catalogs: ModelCatalog[] | undefined }

/// The hints read differently once the same field edits the account default
/// itself, where there is no default to follow and no empty state.
const defaultsHints: Partial<Record<CopyKey, { en: string; zh: string }>> = {
  contextBudgetHint: { en: "Tokens before automatic compaction; 0 disables it.", zh: "重放上下文超过该 token 数时自动压缩；0 表示关闭。" },
  usdBudgetHint: { en: "A thread stops and waits for you once its settled spend reaches this amount; 0 keeps the limit off.", zh: "已结算花费达到该金额后线程会停下并等待你处理；0 表示不限制。" },
  loadedManualCapHint: { en: "How many Manuals one thread may keep loaded at once; a further load is refused until it unloads one.", zh: "单个线程可同时保持加载的手册数；超过后新的加载会被拒绝，需先卸载一份。" },
  initialManualsHint: { en: "Manuals every new thread loads as it starts, before its first message.", zh: "每个新线程一开始就加载的手册，先于第一条消息。" },
}

/// The settings a Thread carries, rendered once for every surface that edits
/// them: the composer's popover (where each may follow the account default) and
/// the account defaults form (where the values themselves are the default).
/// Keeping one component is what makes the two panels unable to drift apart.
export function ThreadSettingsFields({
  mode, idPrefix, language, disabled, catalogs, model, upstreamId, reasoningEffort, fast,
  contextBudget, usdBudget, loadedManualCap, initialManuals, minimalMode, imageGeneration, audioTranscription,
  onModelChange, onReasoningChange, onFastChange,
}: {
  mode: "override" | "defaults"
  idPrefix: string
  language: "en" | "zh"
  disabled?: boolean
  catalogs: ModelCatalog[] | undefined
  model: string
  upstreamId: string | null
  reasoningEffort: string
  fast: boolean
  contextBudget: ThreadSettingsValue<number>
  usdBudget?: ThreadSettingsValue<number>
  loadedManualCap: ThreadSettingsValue<number>
  initialManuals: { value: string[] | null; fallback: string[]; catalogs: ManualChoice[] | undefined; onChange: (value: string[] | null) => void }
  minimalMode: ThreadSettingsValue<boolean>
  imageGeneration: ModelSettingValue<string>
  audioTranscription: ModelSettingValue<string | null>
  onModelChange: (upstreamId: string, model: string) => void
  onReasoningChange: (effort: ReasoningEffort) => void
  onFastChange: (fast: boolean) => void
}) {
  const text = (key: CopyKey) => mode === "defaults" ? defaultsHints[key]?.[language] ?? copyFor(language, key) : copyFor(language, key)
  const stop = Math.max(0, REASONING_EFFORTS.indexOf(reasoningEffort as ReasoningEffort))
  const following = mode === "override"
  const effectiveManuals = initialManuals.value ?? initialManuals.fallback
  const chosenManuals = new Set(effectiveManuals)
  const manualNames = new Map((initialManuals.catalogs ?? []).map((manual) => [manual.manual_id, manual.name]))
  const availableManuals = (initialManuals.catalogs ?? []).filter((manual) => !chosenManuals.has(manual.manual_id))
  return <>
    <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-model`}>{copyFor(language, "model")}</Label>
      <Select value={modelSelection(upstreamId, model)} onValueChange={(value) => { const parsed = parseModelSelection(value); onModelChange(parsed.upstreamId, parsed.model) }} disabled={disabled}>
        <SelectTrigger id={`${idPrefix}-model`} className="w-full" aria-label={copyFor(language, "model")}><SelectValue placeholder={model} /></SelectTrigger>
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
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Label>{copyFor(language, "reasoningEffort")}</Label>
        <span data-slot="reasoning-effort-value" className="text-xs text-muted-foreground">{reasoningEffort}</span>
      </div>
      <Slider aria-label={copyFor(language, "reasoningEffort")} min={0} max={REASONING_EFFORTS.length - 1} step={1} disabled={disabled} value={[stop]} onValueChange={([value]) => onReasoningChange(REASONING_EFFORTS[value])} />
      <div data-slot="reasoning-effort-scale" className="flex justify-between text-xs text-muted-foreground">{REASONING_EFFORTS.map((item) => <span key={item}>{item}</span>)}</div>
    </div>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <Label className="flex items-center gap-1.5"><ZapIcon className="size-4" />{copyFor(language, "fastMode")}</Label>
      <Switch aria-label={copyFor(language, "fastMode")} checked={fast} disabled={disabled} onCheckedChange={onFastChange} />
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-manual-budget`}>{copyFor(language, "contextBudget")}</Label>
      <Input
        id={`${idPrefix}-manual-budget`}
        type="number"
        min={0}
        max={10000000}
        step={1000}
        inputMode="numeric"
        disabled={disabled}
        placeholder={String(contextBudget.fallback)}
        value={contextBudget.value === null ? "" : String(contextBudget.value)}
        onChange={(event) => {
          const raw = event.target.value.trim()
          const parsed = Number(raw)
          contextBudget.onChange(raw === "" || !Number.isFinite(parsed) ? null : parsed)
        }}
      />
      <p className="text-xs text-muted-foreground">{text("contextBudgetHint")}</p>
    </div>
    {usdBudget && <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-usd-budget`}>{copyFor(language, "usdBudget")}</Label>
      <UsdBudgetInput id={`${idPrefix}-usd-budget`} value={usdBudget.value} fallback={usdBudget.fallback} disabled={disabled} invalid={usdBudget.value !== null && usdBudget.value > MAX_BUDGET_USD_NANOS} onChange={usdBudget.onChange} />
      <p className="text-xs text-muted-foreground">{text("usdBudgetHint")}</p>
      {usdBudget.value !== null && usdBudget.value > MAX_BUDGET_USD_NANOS && <p role="alert" className="text-xs text-destructive">{copyFor(language, "usdBudgetTooLarge")}</p>}
    </div>}
    <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-loaded-manual-cap`}>{copyFor(language, "loadedManualCap")}</Label>
      <Input
        id={`${idPrefix}-loaded-manual-cap`}
        type="number"
        min={1}
        max={64}
        step={1}
        inputMode="numeric"
        disabled={disabled}
        placeholder={String(loadedManualCap.fallback)}
        value={loadedManualCap.value === null ? "" : String(loadedManualCap.value)}
        onChange={(event) => {
          const raw = event.target.value.trim()
          const parsed = Number(raw)
          // The controller refuses a cap outside 1–64 and keeps the previous value,
          // so clamp rather than send a value it cannot store.
          loadedManualCap.onChange(raw === "" || !Number.isFinite(parsed) ? null : Math.min(64, Math.max(1, Math.trunc(parsed))))
        }}
      />
      <p className="text-xs text-muted-foreground">{text("loadedManualCapHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Label>{copyFor(language, "initialManuals")}</Label>
        {following && initialManuals.value !== null && <Button type="button" size="sm" variant="ghost" className="h-6" disabled={disabled} onClick={() => initialManuals.onChange(null)}>{copyFor(language, "initialManualsDefault")}</Button>}
      </div>
      <div data-slot="initial-manuals" className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {effectiveManuals.length === 0 && <p className="text-xs text-muted-foreground">{copyFor(language, "initialManualsEmpty")}</p>}
        {effectiveManuals.map((id) => <span key={id} title={id} className="flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs">
          <span className="truncate">{manualNames.get(id) ?? copyFor(language, "initialManualsUnknown")}</span>
          <button type="button" aria-label={`${copyFor(language, "initialManualsRemove")}: ${manualNames.get(id) ?? id}`} title={copyFor(language, "initialManualsRemove")} disabled={disabled} className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => initialManuals.onChange(effectiveManuals.filter((item) => item !== id))}><XIcon className="size-3" /></button>
        </span>)}
      </div>
      {availableManuals.length > 0 && <Select value="" onValueChange={(id) => { if (id && !chosenManuals.has(id)) initialManuals.onChange([...effectiveManuals, id]) }} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "initialManualsAdd")}><SelectValue placeholder={copyFor(language, "initialManualsAdd")} /></SelectTrigger>
        <SelectContent><SelectGroup>{availableManuals.map((manual) => <SelectItem key={manual.manual_id} value={manual.manual_id}>{manual.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>}
      <p className="text-xs text-muted-foreground">{following && initialManuals.value === null ? `${text("initialManualsHint")} ${copyFor(language, "initialManualsFollowing")}` : text("initialManualsHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "minimalMode")}</Label>
      <Select value={minimalMode.value === null ? FOLLOW_DEFAULT : minimalMode.value ? "on" : "off"} onValueChange={(value) => minimalMode.onChange(value === FOLLOW_DEFAULT ? null : value === "on")} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "minimalMode")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "minimalModeDefault")} (${minimalMode.fallback ? copyFor(language, "minimalModeOn") : copyFor(language, "minimalModeOff")})`}</SelectItem>}
          <SelectItem value="on">{copyFor(language, "minimalModeOn")}</SelectItem>
          <SelectItem value="off">{copyFor(language, "minimalModeOff")}</SelectItem>
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "minimalModeHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "audioTranscription")}</Label>
      <Select value={audioTranscription.value === null ? (following ? FOLLOW_DEFAULT : "off") : audioTranscription.value} onValueChange={(value) => audioTranscription.onChange(value === FOLLOW_DEFAULT ? null : value === "off" ? null : value)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "audioTranscription")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "audioTranscriptionDefault")} (${audioTranscription.fallback ?? copyFor(language, "audioTranscriptionDisabled")})`}</SelectItem>}
          <SelectItem value="off">{copyFor(language, "audioTranscriptionDisabled")}</SelectItem>
          {imageModelOptions(audioTranscription.catalogs, upstreamId, [audioTranscription.value, audioTranscription.fallback]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "audioTranscriptionHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "imageGeneration")}</Label>
      <Select value={imageGeneration.value === null ? FOLLOW_DEFAULT : imageGeneration.value === "" ? "off" : imageGeneration.value} onValueChange={(value) => imageGeneration.onChange(value === FOLLOW_DEFAULT ? null : value === "off" ? "" : value)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "imageGeneration")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "imageGenerationDefault")} (${imageGeneration.fallback === "" ? copyFor(language, "imageGenerationDisabled") : imageGeneration.fallback})`}</SelectItem>}
          <SelectItem value="off">{copyFor(language, "imageGenerationDisabled")}</SelectItem>
          {imageModelOptions(imageGeneration.catalogs, upstreamId, [imageGeneration.value, imageGeneration.fallback]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "imageGenerationHint")}</p>
    </div>
  </>
}
