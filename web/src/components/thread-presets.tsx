import { useEffect, useRef, useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"

import { useThreadPresets, useThreadPresetEditor } from "@zccz14/cybion-components/internal"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ThreadSettingsFields, type ThreadPreset, type ThreadSettings } from "@zccz14/cybion-components/internal"
import { PlusIcon, Trash2Icon } from "lucide-react"

const copy = {
  en: {
    title: "Thread presets",
    description: "A saved answer to how a Thread should be built: model, endpoint, reasoning effort, the Manuals it opens with, the caps it runs under. A Thread keeps a copy of what it was given, so editing or deleting a preset never reaches a Thread that already exists.",
    newPreset: "New preset",
    editPreset: "Edit preset",
    save: "Save",
    edit: "Edit",
    name: "Preset name",
    nameHint: "Letters, digits, underscore and hyphen. A model names this preset in create_thread to start a child from it.",
    nameTaken: "Another preset already uses this name.",
    nameInvalid: "Use 1-60 letters, digits, underscores or hyphens.",
    namePlaceholder: "researcher",
    usage: "used in {count}",
    start: "Start a Thread",
    empty: "No presets yet",
    emptyHint: "A preset turns “research children run gpt-6-astra at max” from a sentence in a Manual into a name you can point at.",
    manuals: "manuals",
    noManuals: "no Manuals",
    cancel: "Cancel",
    delete: "Delete",
    loadFailed: "Could not load presets",
    writeFailed: "Could not save the preset",
    retry: "Retry",
  },
  zh: {
    title: "线程预设",
    description: "把「这条线程该怎么配」预先存好：模型、端点、推理强度、开场要加载的手册、各项上限。线程创建时会留一份副本，所以改预设、删预设都不会影响已经存在的线程。",
    newPreset: "新建预设",
    editPreset: "编辑预设",
    save: "保存",
    edit: "编辑",
    name: "预设名",
    nameHint: "字母、数字、下划线与短横线。模型在 create_thread 里写这个名字，子线程就按它起步。",
    nameTaken: "这个预设名已经存在。",
    nameInvalid: "用 1-60 个字母、数字、下划线或短横线。",
    namePlaceholder: "researcher",
    usage: "用过 {count} 次",
    start: "以此起线程",
    empty: "还没有预设",
    emptyHint: "预设的作用，是把「研究子线程用 gpt-6-astra MAX」这句写在手册里的话，变成一个可以指名的设置。",
    manuals: "本手册",
    noManuals: "无手册",
    cancel: "取消",
    delete: "删除",
    loadFailed: "预设列表读不到",
    writeFailed: "预设没有保存成功",
    retry: "重试",
  },
} as const

/// 一个预设会带来什么：模型、强度、开场手册数。扫一眼就能选。
function summary(preset: ThreadPreset, manualsLabel: string, noManualsLabel: string) {
  const manuals = preset.settings.initial_manual_ids.length
  return [
    preset.settings.model,
    preset.settings.reasoning_effort.toUpperCase(),
    manuals > 0 ? `${manuals} ${manualsLabel}` : noManualsLabel,
  ].join(" · ")
}

/**
 * 预设管理。默认值与预设分处两页、作用域也不同：默认值会穿透到没有指名预设的
 * 新线程，预设是快照。这条差别由文案承担，两处都在说同一句话。
 *
 * 读取、草稿、脏检查与 PUT/DELETE 负载都在包里的钩子里，这里只排版——和
 * `useThreadDefaultsForm` 同一个分工，因为两者编辑的是同一个 schema。
 */
export function ThreadPresets({ language, sessionId }: { language: "en" | "zh"; sessionId: string | null | undefined }) {
  const t = copy[language]
  const navigate = useNavigate()
  const location = useLocation()
  const queryKey = ["thread-presets", sessionId] as const
  const list = useThreadPresets({ queryKey })
  const editor = useThreadPresetEditor({ presets: list.presets, queryKey })
  const [confirming, setConfirming] = useState<string | null>(null)
  // 近路：配置页带着刚调好的默认值过来，落地就替用户把对话框开好。
  const seed = location.state?.presetSeed as ThreadSettings | undefined
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || seed === undefined || !editor.ready) return
    opened.current = true
    editor.openWith(seed)
    navigate({ pathname: location.pathname }, { replace: true, state: null })
  }, [seed, editor, navigate, location.pathname])
  return <>
    <Card>
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {list.error && <Alert>
          <AlertTitle>{t.loadFailed}</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span className="min-w-0 break-words">{list.error.message}</span>
            <Button size="sm" variant="outline" onClick={list.retry}>{t.retry}</Button>
          </AlertDescription>
        </Alert>}
        {list.loading && <div className="flex flex-col gap-3"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
        {!list.loading && list.presets.length === 0 && <div className="rounded-md border border-dashed p-6">
          <p className="text-sm font-medium">{t.empty}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{t.emptyHint}</p>
        </div>}
        {list.presets.length > 0 && <ul className="divide-y rounded-md border">
          {list.presets.map((preset) => <li key={preset.name} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm font-medium">{preset.name}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {summary(preset, t.manuals, t.noManuals)} · {t.usage.replace("{count}", String(preset.thread_count))}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {confirming === preset.name
                ? <>
                    <Button size="sm" variant="destructive" disabled={editor.removing} onClick={() => { editor.remove(preset.name); setConfirming(null) }}>
                      {editor.removing ? <Spinner /> : <Trash2Icon data-icon="inline-start" />}{t.delete}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t.cancel}</Button>
                  </>
                : <Button size="sm" variant="ghost" aria-label={`${t.delete} ${preset.name}`} onClick={() => setConfirming(preset.name)}><Trash2Icon /></Button>}
              <Button size="sm" variant="outline" onClick={() => navigate("/threads/new", { state: { preset: preset.name } })}>{t.start}</Button>
              <Button size="sm" variant="outline" onClick={() => editor.openEdit(preset)}>{t.edit}</Button>
            </div>
          </li>)}
        </ul>}
        {editor.failure && <Alert>
          <AlertTitle>{t.writeFailed}</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span className="min-w-0 break-words">{editor.failure.message}</span>
            <Button size="sm" variant="outline" onClick={editor.close}>{t.retry}</Button>
          </AlertDescription>
        </Alert>}
        <div><Button onClick={editor.openNew} disabled={!editor.ready}><PlusIcon data-icon="inline-start" />{t.newPreset}</Button></div>
      </CardContent>
    </Card>
    <Dialog open={editor.draft !== null} onOpenChange={(open) => { if (!open) editor.close() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editor.draft?.created === false ? t.editPreset : t.newPreset}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        {editor.draft && <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="thread-preset-name">{t.name}</FieldLabel>
              <Input
                id="thread-preset-name"
                value={editor.draft.name}
                disabled={!editor.draft.created || editor.pending}
                placeholder={t.namePlaceholder}
                onChange={(event) => editor.setName(event.target.value)}
              />
              <FieldDescription>{editor.nameTaken ? t.nameTaken : editor.nameInvalid ? t.nameInvalid : t.nameHint}</FieldDescription>
            </Field>
          </FieldGroup>
          <FieldGroup>
            <ThreadSettingsFields
              mode="defaults"
              idPrefix="thread-preset"
              value={editor.draft.value}
              onChange={editor.setValue}
              language={language}
              disabled={editor.pending}
            />
          </FieldGroup>
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={editor.close}>{t.cancel}</Button>
          <Button disabled={!editor.canSave} onClick={editor.save}>
            {editor.pending ? <Spinner /> : null}{t.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
