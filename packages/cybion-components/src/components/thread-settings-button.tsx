import { useMutation, useQueryClient } from "@tanstack/react-query"

import type { Thread, ThreadPatch } from "../api"
import { copyFor } from "../copy"
import { FALLBACK_CONTEXT_BUDGET, FALLBACK_LOADED_MANUALS, useManualChoices, useThread, useThreadDefaults, useUpstreamModels } from "../hooks/use-thread-settings-data"
import { useCybion } from "../provider"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ThreadSettingsFields, type ReasoningEffort } from "./thread-settings-fields"

/**
 * Thread settings as one drop-in control: the trigger, the panel, the catalogs it
 * picks from, and the writes it makes.
 *
 * Everything below it is already in the package — the provider knows the origin and
 * the token, the fields are `ThreadSettingsFields` — so a host that renders a Thread
 * somewhere else (another page, a sidebar, an embedding) gets the same panel with
 * `threadId` alone. Pass `value` when the host already holds the Thread and wants
 * the button to agree with it; the panel still saves through the same PATCH.
 */
export function ThreadSettingsButton({ threadId, value, disabled, className, defaultOpen }: {
  threadId: string
  /** The Thread the host already rendered, so the trigger never flashes a stale model. */
  value?: Thread
  disabled?: boolean
  className?: string
  /** Keep the panel open on mount; a host may also drive it as a page section. */
  defaultOpen?: boolean
}) {
  const { client: transport, language } = useCybion()
  const client = useQueryClient()
  const thread = useThread(threadId)
  const defaults = useThreadDefaults()
  const models = useUpstreamModels()
  const imageModels = useUpstreamModels("image")
  const audioModels = useUpstreamModels("sst")
  const manualChoices = useManualChoices()
  const settings = useMutation({
    mutationFn: (patch: ThreadPatch) => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const current = thread.data ?? value
  if (!current) return <Button type="button" variant="outline" disabled className={className}>{copyFor(language, "threadSettings")}</Button>
  const fallbacks = defaults.data
  return <Popover defaultOpen={defaultOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" className={`min-w-0 shrink gap-0 ${className ?? ""}`} aria-label={`${copyFor(language, "threadSettings")}: ${current.model} (${current.reasoning_effort})`} title={copyFor(language, "threadSettings")} disabled={disabled}><span className="truncate">{current.model}</span><span className="whitespace-pre"> ({current.reasoning_effort})</span></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto overscroll-contain">
      <ThreadSettingsFields
        mode="override"
        idPrefix="thread-settings"
        language={language}
        disabled={disabled || settings.isPending}
        catalogs={models.data?.upstreams}
        model={current.model}
        upstreamId={current.upstream_id}
        reasoningEffort={current.reasoning_effort}
        fast={current.service_tier_fast}
        contextBudget={{ value: current.context_budget_tokens, fallback: fallbacks?.context_budget_tokens ?? FALLBACK_CONTEXT_BUDGET, onChange: (context_budget_tokens) => settings.mutate({ context_budget_tokens }) }}
        usdBudget={{ value: current.budget_usd_nanos, fallback: fallbacks?.budget_usd_nanos ?? 0, onChange: (budget_usd_nanos) => settings.mutate({ budget_usd_nanos }) }}
        loadedManualCap={{ value: current.max_loaded_manuals, fallback: fallbacks?.max_loaded_manuals ?? FALLBACK_LOADED_MANUALS, onChange: (max_loaded_manuals) => settings.mutate({ max_loaded_manuals }) }}
        initialManuals={{ value: current.initial_manual_ids ?? null, fallback: fallbacks?.initial_manual_ids ?? [], catalogs: manualChoices.data?.manuals, onChange: (initial_manual_ids) => settings.mutate({ initial_manual_ids }) }}
        minimalMode={{ value: current.minimal_mode, fallback: fallbacks?.minimal_mode ?? false, onChange: (minimal_mode) => settings.mutate({ minimal_mode }) }}
        imageGeneration={{ value: current.image_generation_model, fallback: fallbacks?.image_generation_model ?? "", catalogs: imageModels.data?.upstreams, onChange: (image_generation_model) => settings.mutate({ image_generation_model }) }}
        audioTranscription={{ value: current.audio_transcription_model, fallback: fallbacks?.audio_transcription_model ?? null, catalogs: audioModels.data?.upstreams, onChange: (audio_transcription_model) => settings.mutate({ audio_transcription_model }) }}
        onModelChange={(upstream_id, model) => settings.mutate({ upstream_id, model })}
        onReasoningChange={(reasoning_effort: ReasoningEffort) => settings.mutate({ reasoning_effort })}
        onFastChange={(service_tier_fast) => settings.mutate({ service_tier_fast })}
      />
    </PopoverContent>
  </Popover>
}
