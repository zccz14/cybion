import { useMutation, useQueryClient } from "@tanstack/react-query"

import type { Thread, ThreadPatch } from "../api"
import { copyFor } from "../copy"
import { useThread } from "../hooks/use-thread-settings-data"
import { threadSettingsFromThread, threadSettingsPatch, type ThreadSettings } from "../lib/thread-settings"
import { useCybion } from "../provider"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { ThreadSettingsFields } from "./thread-settings-fields"

/**
 * A Thread's settings as one drop-in control: the trigger, the panel and the
 * writes it makes, from `threadId` alone.
 *
 * The panel itself is `ThreadSettingsFields` — the same control the account
 * defaults form and the new-Thread composer render — so a setting added once
 * shows up on all three surfaces. What this adds is only the Thread side: it
 * reads the row, hands the fields the Thread's own values (where `null` means
 * "follow the account default"), and PATCHes back just what changed.
 *
 * Pass `value` when the host already holds the Thread and wants the button to
 * agree with it; the panel still saves through the same PATCH.
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
  const settings = useMutation({
    mutationFn: (patch: ThreadPatch) => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["thread", threadId] })
      void client.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const current = thread.data ?? value
  if (!current) return <Button type="button" variant="outline" disabled className={className}>{copyFor(language, "threadSettings")}</Button>
  const saved = threadSettingsFromThread(current)
  const save = (next: ThreadSettings) => {
    const patch = threadSettingsPatch(next, saved)
    if (patch) settings.mutate(patch)
  }
  return <Popover defaultOpen={defaultOpen}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" className={`min-w-0 shrink gap-0 ${className ?? ""}`} aria-label={`${copyFor(language, "threadSettings")}: ${current.model} (${current.reasoning_effort})`} title={copyFor(language, "threadSettings")} disabled={disabled}><span className="truncate">{current.model}</span><span className="whitespace-pre"> ({current.reasoning_effort})</span></Button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto overscroll-contain">
      <ThreadSettingsFields mode="override" idPrefix="thread-settings" value={saved} onChange={save} language={language} disabled={disabled || settings.isPending} />
    </PopoverContent>
  </Popover>
}
