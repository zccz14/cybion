import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import type { Thread, ThreadDefaults } from "../api"
import { useCybion } from "../provider"
import {
  budgetTooLarge, sameThreadSettings, threadSettingsDefaults, threadSettingsForNewThread,
  threadSettingsFromDefaults, threadSettingsFromThread, threadSettingsPatch,
  type ThreadSettings,
} from "../lib/thread-settings"

/// 请求失败一律给宿主一个 `Error`，它自己的错误渲染器就能直接用。
function asError(error: unknown): Error | null {
  if (error === null || error === undefined) return null
  return error instanceof Error ? error : new Error(String(error))
}

/// 编辑中的账号默认设置。读取、草稿、脏检查、保存都在这里，宿主只拿到一个
/// `value`/`onChange` 和一个已经接好线的表单状态——不必知道草稿怎么和已保存的
/// 值比较，也不必自己拼 PUT 负载。
export type ThreadDefaultsForm = {
  /** `null` 表示默认值还没到。 */
  value: ThreadSettings | null
  onChange: (next: ThreadSettings) => void
  /** 与已保存的值相比确实有改动。 */
  changed: boolean
  /** 干净到可以提交（有改动、不在保存中、金额没超上限）。 */
  canSave: boolean
  save: () => void
  pending: boolean
  error: Error | null
  saved: boolean
  loading: boolean
  /** 读取失败时给宿主的重试。 */
  retry: () => void
}

export function useThreadDefaultsForm({ queryKey = ["thread-defaults"] }: { queryKey?: readonly unknown[] } = {}): ThreadDefaultsForm {
  const { client } = useCybion()
  const cache = useQueryClient()
  const [draft, setDraft] = useState<ThreadSettings | null>(null)
  const defaults = useQuery({ queryKey: [...queryKey], queryFn: ({ signal }) => client.request<ThreadDefaults>("/api/thread-defaults", { signal }) })
  const mutation = useMutation({
    mutationFn: (value: ThreadDefaults) => client.request<ThreadDefaults>("/api/thread-defaults", { method: "PUT", body: JSON.stringify(value) }),
    onMutate: () => cache.cancelQueries({ queryKey: [...queryKey] }),
    onSuccess: (value) => {
      cache.setQueryData([...queryKey], value)
      setDraft(null)
    },
  })
  const saved = defaults.data ? threadSettingsFromDefaults(defaults.data) : null
  const value = draft ?? saved
  // 要发出去的负载，逐字段和服务器上的值比较：清空一个输入框保留已保存的值，
  // 因此清空不算改动；以后新增设置项也会自动进入这份比较。
  const payload = value !== null && saved !== null ? threadSettingsDefaults(value, saved) : null
  const changed = payload !== null && !sameThreadSettings(threadSettingsFromDefaults(payload), saved!)
  const canSave = changed && !mutation.isPending && !budgetTooLarge(payload?.budget_usd_nanos ?? null)
  return {
    value,
    onChange: (next) => { setDraft(next); mutation.reset() },
    changed,
    canSave,
    save: () => { if (payload && canSave) mutation.mutate(payload) },
    pending: mutation.isPending,
    error: asError(mutation.error) ?? asError(defaults.error),
    saved: mutation.isSuccess,
    loading: defaults.isLoading,
    retry: () => { void defaults.refetch() },
  }
}

/// 一个还不存在的 Thread：模型取自账号默认，其余七项跟随默认，直到 composer
/// 把它们钉住。`payload` 就是 `POST /api/threads/start` 要的那几项。
export type NewThreadSettings = {
  value: ThreadSettings | null
  onChange: (next: ThreadSettings) => void
  /** 第一条消息创建 Thread 时带上的设置。 */
  payload: Omit<ThreadSettings, "model" | "upstream_id" | "reasoning_effort" | "service_tier_fast"> | null
  /** 模型与推理强度也要随消息发出。 */
  model: Pick<ThreadSettings, "model" | "upstream_id" | "reasoning_effort" | "service_tier_fast"> | null
  loading: boolean
  error: Error | null
  retry: () => void
}

export function useNewThreadSettings({ queryKey = ["thread-defaults"] }: { queryKey?: readonly unknown[] } = {}): NewThreadSettings {
  const { client } = useCybion()
  const [draft, setDraft] = useState<ThreadSettings | null>(null)
  const defaults = useQuery({ queryKey: [...queryKey], queryFn: ({ signal }) => client.request<ThreadDefaults>("/api/thread-defaults", { signal }) })
  const value = draft ?? (defaults.data ? threadSettingsForNewThread(threadSettingsFromDefaults(defaults.data)) : null)
  return {
    value,
    onChange: setDraft,
    payload: value && {
      context_budget_tokens: value.context_budget_tokens,
      minimal_mode: value.minimal_mode,
      image_generation_model: value.image_generation_model,
      audio_transcription_model: value.audio_transcription_model,
      search_source: value.search_source,
      max_loaded_manuals: value.max_loaded_manuals,
      initial_manual_ids: value.initial_manual_ids,
      budget_usd_nanos: value.budget_usd_nanos,
    },
    model: value && {
      model: value.model,
      upstream_id: value.upstream_id,
      reasoning_effort: value.reasoning_effort,
      service_tier_fast: value.service_tier_fast,
    },
    loading: defaults.isLoading,
    error: asError(defaults.error),
    retry: () => { void defaults.refetch() },
  }
}

/// 一个 Thread 的设置面板：读行、只 PATCH 真正变化的字段。宿主给个 id，
/// 拿回来的 `value`/`onChange` 直接交给 `ThreadSettingsFields`。
export type ThreadSettingsPanel = {
  value: ThreadSettings | null
  onChange: (next: ThreadSettings) => void
  pending: boolean
  /** 宿主已经渲染过的 Thread，面板据此不必等读取。 */
  thread: Thread | undefined
}

export function useThreadSettingsPanel(threadId: string, options: { value?: Thread; enabled?: boolean } = {}): ThreadSettingsPanel {
  const { client: transport } = useCybion()
  const cache = useQueryClient()
  const thread = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
    enabled: options.enabled ?? Boolean(threadId),
  })
  const mutation = useMutation({
    mutationFn: (patch: object) => transport.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["thread", threadId] })
      void cache.invalidateQueries({ queryKey: ["threads"] })
    },
  })
  const current = options.value ?? thread.data
  const saved = current ? threadSettingsFromThread(current) : null
  return {
    value: saved,
    onChange: (next) => {
      if (!saved) return
      const patch = threadSettingsPatch(next, saved)
      if (patch) mutation.mutate(patch)
    },
    pending: mutation.isPending,
    thread: current,
  }
}
