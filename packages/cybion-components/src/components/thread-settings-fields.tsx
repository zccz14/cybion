import { XIcon, ZapIcon } from "lucide-react"

import { imageModelOptions, modelGroups, modelSelection, parseModelSelection } from "../lib/model-catalog"
import {
  FALLBACK_CONTEXT_BUDGET, FALLBACK_LOADED_MANUALS, REASONING_EFFORTS,
  budgetTooLarge, threadSettingsFromDefaults, type ReasoningEffort, type ThreadSettings,
} from "../lib/thread-settings"
import { copyFor, type CopyKey } from "../copy"
import { useManualChoices, useThreadDefaults, useUpstreamModels, useUpstreamSearchSources } from "../hooks/use-thread-settings-data"
import type { UpstreamSourceCatalog } from "../api"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select"
import { Slider } from "../ui/slider"
import { Switch } from "../ui/switch"
import { UsdBudgetInput } from "./usd-budget-input"

/// The select value that means "leave this alone"; display text changes with the
/// language, so it must never be the value itself.
const FOLLOW_DEFAULT = "\u0000default"

/// What the panel assumes before `/api/thread-defaults` answers: the account's
/// own settings, or these literals while it loads, so no field is ever empty.
const beforeDefaults: ThreadSettings = {
  model: "", upstream_id: null, reasoning_effort: "medium", service_tier_fast: false,
  context_budget_tokens: FALLBACK_CONTEXT_BUDGET, minimal_mode: false,
  image_generation_model: "", audio_transcription_model: null, search_source: null,
  max_loaded_manuals: FALLBACK_LOADED_MANUALS, initial_manual_ids: [], budget_usd_nanos: 0,
}

/// The hints read differently once the same field edits the account default
/// itself, where there is no default to follow and no empty state.
const defaultsHints: Partial<Record<CopyKey, { en: string; zh: string }>> = {
  contextBudgetHint: { en: "Tokens before automatic compaction; 0 disables it.", zh: "重放上下文超过该 token 数时自动压缩；0 表示关闭。" },
  usdBudgetHint: { en: "A thread stops and waits for you once its settled spend reaches this amount; 0 keeps the limit off.", zh: "已结算花费达到该金额后线程会停下并等待你处理；0 表示不限制。" },
  loadedManualCapHint: { en: "How many Manuals one thread may keep loaded at once; a further load is refused until it unloads one.", zh: "单个线程可同时保持加载的手册数；超过后新的加载会被拒绝，需先卸载一份。" },
  initialManualsHint: { en: "Manuals every new thread loads as it starts, before its first message.", zh: "每个新线程一开始就加载的手册，先于第一条消息。" },
}

/**
 * Every Thread setting, as one form control: `value` in, `onChange` out.
 *
 * The value is a whole `ThreadSettings` — the same schema a Thread row and the
 * account defaults both answer — so the account defaults form, the new-Thread
 * composer and an existing Thread's panel render one control instead of three
 * panels that can drift. A `null` on a nullable setting means "follow the account
 * default", which is what a Thread row means by `null`; `mode="defaults"` drops
 * the affordances, because there the value *is* the default.
 *
 * The catalogs and the defaults themselves come from the provider: a host renders
 * this with a value and an onChange and nothing else.
 */
export function ThreadSettingsFields({
  value, onChange, mode = "override", idPrefix = "thread-settings", language, disabled,
}: {
  value: ThreadSettings
  onChange: (value: ThreadSettings) => void
  /** `override` edits a Thread (each setting may follow the default); `defaults` edits the default itself. */
  mode?: "override" | "defaults"
  /** Prefix of the field ids; two panels on one page must not share them. */
  idPrefix?: string
  language: "en" | "zh"
  disabled?: boolean
}) {
  const defaults = useThreadDefaults()
  const models = useUpstreamModels()
  const imageModels = useUpstreamModels("image")
  const audioModels = useUpstreamModels("sst")
  const searchSources = useUpstreamSearchSources()
  const manualChoices = useManualChoices()
  const fallback = defaults.data ? threadSettingsFromDefaults(defaults.data) : beforeDefaults
  const text = (key: CopyKey) => mode === "defaults" ? defaultsHints[key]?.[language] ?? copyFor(language, key) : copyFor(language, key)
  const following = mode === "override"
  // What the Thread actually runs with: its own value, or the default it follows.
  const effective = (field: keyof ThreadSettings) => value[field] ?? fallback[field]
  const set = <K extends keyof ThreadSettings>(field: K, next: ThreadSettings[K]) => onChange({ ...value, [field]: next })
  const stop = Math.max(0, REASONING_EFFORTS.indexOf(value.reasoning_effort))
  const effort: ReasoningEffort = value.reasoning_effort
  const manuals = (effective("initial_manual_ids") as string[] | null) ?? []
  const chosenManuals = new Set(manuals)
  const manualNames = new Map((manualChoices.data?.manuals ?? []).map((manual) => [manual.manual_id, manual.name]))
  const availableManuals = (manualChoices.data?.manuals ?? []).filter((manual) => !chosenManuals.has(manual.manual_id))
  const usdBudget = value.budget_usd_nanos
  return <>
    <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-model`}>{copyFor(language, "model")}</Label>
      <Select value={modelSelection(value.upstream_id, value.model)} onValueChange={(selection) => { const parsed = parseModelSelection(selection); onChange({ ...value, upstream_id: parsed.upstreamId || null, model: parsed.model }) }} disabled={disabled}>
        <SelectTrigger id={`${idPrefix}-model`} className="w-full" aria-label={copyFor(language, "model")}><SelectValue placeholder={value.model} /></SelectTrigger>
        <SelectContent>{modelGroups(models.data?.upstreams, value.upstream_id, value.model).map((group) => (
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
        <span data-slot="reasoning-effort-value" className="text-xs text-muted-foreground">{effort}</span>
      </div>
      <Slider aria-label={copyFor(language, "reasoningEffort")} min={0} max={REASONING_EFFORTS.length - 1} step={1} disabled={disabled} value={[stop]} onValueChange={([next]) => set("reasoning_effort", REASONING_EFFORTS[next])} />
      <div data-slot="reasoning-effort-scale" className="flex justify-between text-xs text-muted-foreground">{REASONING_EFFORTS.map((item) => <span key={item}>{item}</span>)}</div>
    </div>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <Label className="flex items-center gap-1.5"><ZapIcon className="size-4" />{copyFor(language, "fastMode")}</Label>
      <Switch aria-label={copyFor(language, "fastMode")} checked={value.service_tier_fast} disabled={disabled} onCheckedChange={(fast) => set("service_tier_fast", fast)} />
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
        placeholder={String(fallback.context_budget_tokens)}
        value={value.context_budget_tokens === null ? "" : String(value.context_budget_tokens)}
        onChange={(event) => {
          const raw = event.target.value.trim()
          const parsed = Number(raw)
          set("context_budget_tokens", raw === "" || !Number.isFinite(parsed) ? null : parsed)
        }}
      />
      <p className="text-xs text-muted-foreground">{text("contextBudgetHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label htmlFor={`${idPrefix}-usd-budget`}>{copyFor(language, "usdBudget")}</Label>
      <UsdBudgetInput id={`${idPrefix}-usd-budget`} value={usdBudget} fallback={fallback.budget_usd_nanos ?? 0} disabled={disabled} invalid={budgetTooLarge(usdBudget)} onChange={(next) => set("budget_usd_nanos", next)} />
      <p className="text-xs text-muted-foreground">{text("usdBudgetHint")}</p>
      {budgetTooLarge(usdBudget) && <p role="alert" className="text-xs text-destructive">{copyFor(language, "usdBudgetTooLarge")}</p>}
    </div>
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
        placeholder={String(fallback.max_loaded_manuals)}
        value={value.max_loaded_manuals === null ? "" : String(value.max_loaded_manuals)}
        onChange={(event) => {
          const raw = event.target.value.trim()
          const parsed = Number(raw)
          // The controller refuses a cap outside 1–64 and keeps the previous value,
          // so clamp rather than send a value it cannot store.
          set("max_loaded_manuals", raw === "" || !Number.isFinite(parsed) ? null : Math.min(64, Math.max(1, Math.trunc(parsed))))
        }}
      />
      <p className="text-xs text-muted-foreground">{text("loadedManualCapHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Label>{copyFor(language, "initialManuals")}</Label>
        {following && value.initial_manual_ids !== null && <Button type="button" size="sm" variant="ghost" className="h-6" disabled={disabled} onClick={() => set("initial_manual_ids", null)}>{copyFor(language, "initialManualsDefault")}</Button>}
      </div>
      <div data-slot="initial-manuals" className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {manuals.length === 0 && <p className="text-xs text-muted-foreground">{copyFor(language, "initialManualsEmpty")}</p>}
        {manuals.map((id) => <span key={id} title={id} className="flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs">
          <span className="truncate">{manualNames.get(id) ?? copyFor(language, "initialManualsUnknown")}</span>
          <button type="button" aria-label={`${copyFor(language, "initialManualsRemove")}: ${manualNames.get(id) ?? id}`} title={copyFor(language, "initialManualsRemove")} disabled={disabled} className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => set("initial_manual_ids", manuals.filter((item) => item !== id))}><XIcon className="size-3" /></button>
        </span>)}
      </div>
      {availableManuals.length > 0 && <Select value="" onValueChange={(id) => { if (id && !chosenManuals.has(id)) set("initial_manual_ids", [...manuals, id]) }} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "initialManualsAdd")}><SelectValue placeholder={copyFor(language, "initialManualsAdd")} /></SelectTrigger>
        <SelectContent><SelectGroup>{availableManuals.map((manual) => <SelectItem key={manual.manual_id} value={manual.manual_id}>{manual.name}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>}
      <p className="text-xs text-muted-foreground">{following && value.initial_manual_ids === null ? `${text("initialManualsHint")} ${copyFor(language, "initialManualsFollowing")}` : text("initialManualsHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "minimalMode")}</Label>
      <Select value={value.minimal_mode === null ? FOLLOW_DEFAULT : value.minimal_mode ? "on" : "off"} onValueChange={(next) => set("minimal_mode", next === FOLLOW_DEFAULT ? null : next === "on")} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "minimalMode")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "minimalModeDefault")} (${fallback.minimal_mode ? copyFor(language, "minimalModeOn") : copyFor(language, "minimalModeOff")})`}</SelectItem>}
          <SelectItem value="on">{copyFor(language, "minimalModeOn")}</SelectItem>
          <SelectItem value="off">{copyFor(language, "minimalModeOff")}</SelectItem>
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "minimalModeHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "searchSource")}</Label>
      {/* The options are the sources this Thread's own channel serves, read from
          the upstream itself: an offered source is one its call can reach. */}
      <Select value={value.search_source === null ? FOLLOW_DEFAULT : value.search_source} onValueChange={(next) => set("search_source", next === FOLLOW_DEFAULT ? null : next)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "searchSource")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "searchSourceDefault")} (${fallback.search_source ?? ""})`}</SelectItem>}
          {searchSourceOptions(searchSources.data?.upstreams, value.upstream_id, [value.search_source, fallback.search_source]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "searchSourceHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "audioTranscription")}</Label>
      {/* The controller stores an empty speech-to-text model as "follow the default", so
          turning audio off and following the default are the same state here; both read as
          the account default, and picking a model is what keeps audio distinct. */}
      <Select value={value.audio_transcription_model === null || value.audio_transcription_model === "" ? (following ? FOLLOW_DEFAULT : "off") : value.audio_transcription_model} onValueChange={(next) => set("audio_transcription_model", next === FOLLOW_DEFAULT || next === "off" ? null : next)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "audioTranscription")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "audioTranscriptionDefault")} (${fallback.audio_transcription_model || copyFor(language, "audioTranscriptionDisabled")})`}</SelectItem>}
          <SelectItem value="off">{copyFor(language, "audioTranscriptionDisabled")}</SelectItem>
          {imageModelOptions(audioModels.data?.upstreams, value.upstream_id, [value.audio_transcription_model, fallback.audio_transcription_model]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "audioTranscriptionHint")}</p>
    </div>
    <div className="flex shrink-0 flex-col gap-2">
      <Label>{copyFor(language, "imageGeneration")}</Label>
      <Select value={value.image_generation_model === null ? FOLLOW_DEFAULT : value.image_generation_model === "" ? "off" : value.image_generation_model} onValueChange={(next) => set("image_generation_model", next === FOLLOW_DEFAULT ? null : next === "off" ? "" : next)} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={copyFor(language, "imageGeneration")}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          {following && <SelectItem value={FOLLOW_DEFAULT}>{`${copyFor(language, "imageGenerationDefault")} (${fallback.image_generation_model === "" ? copyFor(language, "imageGenerationDisabled") : fallback.image_generation_model})`}</SelectItem>}
          <SelectItem value="off">{copyFor(language, "imageGenerationDisabled")}</SelectItem>
          {imageModelOptions(imageModels.data?.upstreams, value.upstream_id, [value.image_generation_model, fallback.image_generation_model]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectGroup></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{copyFor(language, "imageGenerationHint")}</p>
    </div>
  </>
}

export { REASONING_EFFORTS }
export type { ReasoningEffort }

/// Search sources the upstream serving this Thread offers, plus any the current
/// values already name so a saved choice stays selectable before the catalog lands.
function searchSourceOptions(
  upstreams: UpstreamSourceCatalog[] | undefined,
  upstreamId: string | null,
  selected: (string | null)[],
) {
  const served = (upstreams ?? [])
    .filter((upstream) => upstream.id === upstreamId)
    .flatMap((upstream) => upstream.sources)
  const named = selected.filter((source): source is string => Boolean(source))
  return Array.from(new Set([...served, ...named])).sort()
}
