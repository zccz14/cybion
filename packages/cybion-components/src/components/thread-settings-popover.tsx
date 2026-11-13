import { XIcon, ZapIcon } from "lucide-react"
import { Button } from "../ui/button"
import { Label } from "../ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select"
import { Input } from "../ui/input"
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

type ThreadSettingsCopyKey = "settings" | "model" | "reasoningEffort" | "fastMode" | "contextBudget" | "contextBudgetHint" | "loadedManualCap" | "loadedManualCapHint" | "initialManuals" | "initialManualsHint" | "initialManualsFollowing" | "initialManualsAdd" | "initialManualsDefault" | "initialManualsEmpty" | "initialManualsUnknown" | "initialManualsRemove" | "minimalMode" | "minimalModeHint" | "minimalModeDefault" | "minimalModeOn" | "minimalModeOff" | "imageGeneration" | "imageGenerationHint" | "imageGenerationDefault" | "imageGenerationDisabled" | "audioTranscription" | "audioTranscriptionHint" | "audioTranscriptionDefault" | "audioTranscriptionDisabled"

const copy = {
  en: { settings: "Thread settings", model: "Model", reasoningEffort: "Reasoning effort", fastMode: "Fast mode", contextBudget: "Context budget", contextBudgetHint: "Tokens before automatic compaction; empty follows the default.", loadedManualCap: "Loaded manuals", loadedManualCapHint: "Manuals this thread may keep loaded at once; empty follows the default.", initialManuals: "Initial manuals", initialManualsHint: "Loaded the moment the thread starts, before its first message. Adding or removing one here loads or releases it now; the model's own loads stay.", initialManualsFollowing: "Following the account default.", initialManualsAdd: "Add a manual…", initialManualsDefault: "Follow default", initialManualsEmpty: "No initial manual: a new thread starts empty until you add one.", initialManualsUnknown: "Unknown manual", initialManualsRemove: "Remove", minimalMode: "Minimal mode", minimalModeHint: "Only the final reply or status of each turn stays open.", minimalModeDefault: "Follow default", minimalModeOn: "On", minimalModeOff: "Off", imageGeneration: "Image generation", imageGenerationHint: "The image model served by this thread's upstream; Disabled turns image generation off.", imageGenerationDefault: "Follow default", imageGenerationDisabled: "Disabled", audioTranscription: "Speech-to-text", audioTranscriptionHint: "The speech-to-text model behind audio input; Disabled turns audio input off.", audioTranscriptionDefault: "Follow default", audioTranscriptionDisabled: "Disabled" },
  zh: { settings: "线程设置", model: "模型", reasoningEffort: "推理强度", fastMode: "快速模式", contextBudget: "重放预算", contextBudgetHint: "超过后自动压缩；留空跟随默认值。", loadedManualCap: "已加载手册上限", loadedManualCapHint: "本线程可同时保持加载的手册数；留空跟随默认值。", initialManuals: "初始手册", initialManualsHint: "线程一开始就加载，先于第一条消息。在这里添加或移除会立即加载或卸载；模型自己加载的手册不受影响。", initialManualsFollowing: "当前跟随账号默认。", initialManualsAdd: "添加手册…", initialManualsDefault: "跟随默认", initialManualsEmpty: "还没有初始手册：新线程从空开始，添加一个即可。", initialManualsUnknown: "未知手册", initialManualsRemove: "移除", minimalMode: "极简模式", minimalModeHint: "每轮仅展开最后一条回复或状态。", minimalModeDefault: "跟随默认", minimalModeOn: "开启", minimalModeOff: "关闭", imageGeneration: "图像生成", imageGenerationHint: "由该线程的上游提供的图像模型；选择关闭即禁用图像生成。", imageGenerationDefault: "跟随默认", imageGenerationDisabled: "关闭", audioTranscription: "语音识别", audioTranscriptionHint: "音频输入使用的语音识别模型；选择关闭即禁用音频输入。", audioTranscriptionDefault: "跟随默认", audioTranscriptionDisabled: "关闭" },
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

/// One Manual the picker can offer: the ids `GET /api/manual-summaries`
/// answers with, and nothing else about the Manual.
export type ManualChoice = { manual_id: string; name: string }

export function ThreadSettingsPopover({ model, upstreamId, catalogs, reasoningEffort, fast, language, contextBudget, loadedManualCap, initialManuals, minimalMode, imageGeneration, audioTranscription, disabled, onModelChange, onReasoningChange, onFastChange }: {
  model: string
  upstreamId: string | null
  catalogs: ModelCatalog[] | undefined
  reasoningEffort: string
  fast: boolean
  language: "en" | "zh"
  contextBudget: { override: number | null; fallback: number; onChange: (value: number | null) => void }
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
        <div className="flex shrink-0 items-center justify-between gap-2">
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
      <div className="flex shrink-0 flex-col gap-2">
        <Label htmlFor="thread-settings-manual-budget">{t.contextBudget}</Label>
        <Input
          id="thread-settings-manual-budget"
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
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <Label htmlFor="thread-settings-loaded-manual-cap">{t.loadedManualCap}</Label>
        <Input
          id="thread-settings-loaded-manual-cap"
          type="number"
          min={1}
          max={64}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          placeholder={String(loadedManualCap.fallback)}
          value={loadedManualCap.override === null ? "" : String(loadedManualCap.override)}
          onChange={(event) => {
            const raw = event.target.value.trim()
            const parsed = Number(raw)
            // The controller refuses a cap outside 1–64 and the Thread keeps its
            // previous value, so clamp rather than send a value it cannot store.
            loadedManualCap.onChange(raw === "" || !Number.isFinite(parsed) ? null : Math.min(64, Math.max(1, Math.trunc(parsed))))
          }}
        />
        <p className="text-xs text-muted-foreground">{t.loadedManualCapHint}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <Label>{t.initialManuals}</Label>
          {initialManuals.override !== null && <Button type="button" size="sm" variant="ghost" className="h-6" disabled={disabled} onClick={() => initialManuals.onChange(null)}>{t.initialManualsDefault}</Button>}
        </div>
        {(() => {
          const effective = initialManuals.override ?? initialManuals.fallback ?? []
          const chosen = new Set(effective)
          const names = new Map((initialManuals.catalogs ?? []).map((manual) => [manual.manual_id, manual.name]))
          const available = (initialManuals.catalogs ?? []).filter((manual) => !chosen.has(manual.manual_id))
          return <>
            <div data-slot="initial-manuals" className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {effective.length === 0 && <p className="text-xs text-muted-foreground">{t.initialManualsEmpty}</p>}
              {effective.map((id) => <span key={id} title={id} className="flex min-w-0 max-w-full items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs">
                <span className="truncate">{names.get(id) ?? t.initialManualsUnknown}</span>
                <button type="button" aria-label={`${t.initialManualsRemove}: ${names.get(id) ?? id}`} title={t.initialManualsRemove} disabled={disabled} className="shrink-0 rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => initialManuals.onChange(effective.filter((item) => item !== id))}><XIcon className="size-3" /></button>
              </span>)}
            </div>
            {available.length > 0 && <Select value="" onValueChange={(id) => { if (id && !chosen.has(id)) initialManuals.onChange([...effective, id]) }} disabled={disabled}>
              <SelectTrigger className="w-full" aria-label={t.initialManualsAdd}><SelectValue placeholder={t.initialManualsAdd} /></SelectTrigger>
              <SelectContent><SelectGroup>{available.map((manual) => <SelectItem key={manual.manual_id} value={manual.manual_id}>{manual.name}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>}
          </>
        })()}
        <p className="text-xs text-muted-foreground">{initialManuals.override === null ? `${t.initialManualsHint} ${t.initialManualsFollowing}` : t.initialManualsHint}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
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
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        <Label>{t.audioTranscription}</Label>
        <Select value={audioTranscription.override ?? "default"} onValueChange={(value) => audioTranscription.onChange(value === "default" ? null : value)} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={t.audioTranscription}><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>
            <SelectItem value="default">{`${t.audioTranscriptionDefault} (${audioTranscription.fallback ?? t.audioTranscriptionDisabled})`}</SelectItem>
            {imageModelOptions(audioTranscription.catalogs, upstreamId, [audioTranscription.override, audioTranscription.fallback]).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t.audioTranscriptionHint}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
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
      </div>
    </PopoverContent>
  </Popover>
}
