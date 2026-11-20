import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import type { ThreadDefaults } from "../api"
import { useCybion } from "../provider"
import { threadSettingsDefaults, threadSettingsFromDefaults, type ThreadSettings } from "../lib/thread-settings"

/// 请求失败一律给宿主一个 `Error`，它自己的错误渲染器就能直接用。
function asError(error: unknown): Error | null {
  if (error === null || error === undefined) return null
  return error instanceof Error ? error : new Error(String(error))
}

/** 一个具名设置快照，连同用过它起线程的数量。 */
export type ThreadPreset = {
  name: string
  /** 什么时候该用它：写条件，不写简介。模型靠它选，人靠它记。 */
  use_when: string
  settings: ThreadDefaults
  /** 以它起过的线程数。读的是线程自己留下的名字，预设删了数字也还在。 */
  thread_count: number
}

/// 预设名要能进 URL，也要能被模型写进 `create_thread`，所以它是 slug。
const PRESET_NAME = /^[A-Za-z0-9_-]{1,60}$/

export type ThreadPresetList = {
  presets: ThreadPreset[]
  loading: boolean
  error: Error | null
  retry: () => void
  /** 把一个预设摊成设置面板认的值：抄近路就是把它填回新建页。 */
  settingsOf: (preset: ThreadPreset) => ThreadSettings
}

/// 预设列表。近路与页面读同一份缓存，所以列表里的数字和创建时用的设置同源。
export function useThreadPresets({
  queryKey = ["thread-presets"],
  enabled = true,
}: { queryKey?: readonly unknown[]; enabled?: boolean } = {}): ThreadPresetList {
  const { client } = useCybion()
  const query = useQuery({
    queryKey: [...queryKey],
    queryFn: ({ signal }) => client.request<ThreadPreset[]>("/api/thread-presets", { signal }),
    enabled,
  })
  return {
    presets: query.data ?? [],
    loading: query.isLoading,
    error: asError(query.error),
    retry: () => { void query.refetch() },
    settingsOf: (preset) => threadSettingsFromDefaults(preset.settings),
  }
}

/** 正在编辑的预设：名字、草稿值，以及打开时那一份基准值。 */
export type ThreadPresetDraft = {
  name: string
  /** 打开时它叫什么；PUT 打到这个名字上，`name` 与它不同就是改名。 */
  original: string
  use_when: string
  value: ThreadSettings
  /** 新建还是编辑。两者都能改名字，区别只在 PUT 的目标。 */
  created: boolean
  /** 草稿里跟随默认的字段，按打开时的这份值落定。 */
  base: ThreadSettings
}

export type ThreadPresetEditor = {
  draft: ThreadPresetDraft | null
  /** 账户默认已到，可以开新草稿。 */
  ready: boolean
  openNew: () => void
  openEdit: (preset: ThreadPreset) => void
  /** 带着一份现成的设置开新草稿：配置页刚调好的默认值就是这样过来的。 */
  openWith: (value: ThreadSettings) => void
  close: () => void
  setName: (name: string) => void
  setUseWhen: (useWhen: string) => void
  setValue: (value: ThreadSettings) => void
  nameInvalid: boolean
  nameTaken: boolean
  useWhenInvalid: boolean
  canSave: boolean
  save: () => void
  remove: (name: string) => void
  pending: boolean
  removing: boolean
  failure: Error | null
}

/// 预设的读取、草稿、脏检查、PUT/DELETE 负载都在这里，页面只负责排版——和
/// `useThreadDefaultsForm` 同一个分工，因为两者编辑的是同一个 schema。
export function useThreadPresetEditor({
  presets,
  queryKey = ["thread-presets"],
}: { presets: ThreadPreset[]; queryKey?: readonly unknown[] }): ThreadPresetEditor {
  const { client } = useCybion()
  const cache = useQueryClient()
  const defaults = useQuery({
    queryKey: ["thread-defaults"],
    queryFn: ({ signal }) => client.request<ThreadDefaults>("/api/thread-defaults", { signal }),
  })
  const [draft, setDraft] = useState<ThreadPresetDraft | null>(null)
  const base = defaults.data ? threadSettingsFromDefaults(defaults.data) : null
  const publish = useMutation({
    mutationFn: (input: ThreadPresetDraft) =>
      client.request<ThreadPreset>(
        `/api/thread-presets/${encodeURIComponent(input.original === "" ? input.name : input.original)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            name: input.name,
            use_when: input.use_when,
            settings: threadSettingsDefaults(input.value, input.base),
          }),
        },
      ),
    onSuccess: () => {
      setDraft(null)
      void cache.invalidateQueries({ queryKey: [...queryKey] })
    },
  })
  const destroy = useMutation({
    mutationFn: (name: string) =>
      client.request<{ deleted: boolean }>(`/api/thread-presets/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: [...queryKey] }) },
  })
  const name = draft?.name.trim() ?? ""
  // 改 use_when 时名字没动，不能把它自己算成「已被占用」。
  const nameTaken = draft !== null && presets.some((preset) => preset.name === name && preset.name !== draft.original)
  const nameInvalid = draft !== null && !PRESET_NAME.test(name)
  const useWhenInvalid = draft !== null && (draft.use_when.trim() === "" || draft.use_when.trim().length > 500)
  const canSave = draft !== null && !nameInvalid && !nameTaken && !useWhenInvalid && !publish.isPending
  return {
    draft,
    ready: base !== null,
    openNew: () => { if (base) setDraft({ name: "", original: "", use_when: "", value: base, created: true, base }) },
    openEdit: (preset) => {
      const seed = threadSettingsFromDefaults(preset.settings)
      setDraft({ name: preset.name, original: preset.name, use_when: preset.use_when, value: seed, created: false, base: seed })
    },
    openWith: (value) => { if (base) setDraft({ name: "", original: "", use_when: "", value, created: true, base }) },
    close: () => { setDraft(null); publish.reset() },
    setName: (next) => { setDraft((current) => current && { ...current, name: next }); publish.reset() },
    setUseWhen: (next) => { setDraft((current) => current && { ...current, use_when: next }); publish.reset() },
    setValue: (value) => { setDraft((current) => current && { ...current, value }) },
    nameInvalid: nameInvalid && name !== "",
    nameTaken,
    useWhenInvalid,
    canSave,
    save: () => { if (draft !== null && canSave) publish.mutate({ ...draft, name }) },
    remove: (target) => { destroy.mutate(target) },
    pending: publish.isPending,
    removing: destroy.isPending,
    failure: asError(publish.error) ?? asError(destroy.error),
  }
}
