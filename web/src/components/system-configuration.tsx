import { useState, type ChangeEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CircleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

type Language = "en" | "zh"
type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Props = { language: Language; sessionId: string | null | undefined; request: Request }
type ExperimentalFeatures = { thread_id_header: boolean; session_id_header: boolean }
type NoteSettings = { thread_max_chars: number }
const NOTE_CHAR_CEILING = 2000
const copy = {
  en: {
    experimentalFeatures: "Experimental features",
    experimentalFeaturesDescription: "Global controls for experimental request behavior.",
    threadIdHeader: "Send Thread ID header",
    threadIdHeaderDescription: "Add thread-id: <UUID> to upstream Responses requests for every thread and API client.",
    sessionIdHeader: "Send Session ID header",
    sessionIdHeaderDescription: "Add session-id: <Thread ID> to upstream Responses requests for every thread and API client. Disabled by default and independent of the Thread ID header switch.",
    saveExperimentalError: "Could not save experimental feature settings",
    notesTitle: "Sticky notes",
    notesDescription: "Character limits the service enforces when a note is added. A longer note is refused with a message that asks the model to condense it, so the note is rewritten instead of silently truncated.",
    threadMaxChars: "Note limit",
    threadMaxCharsDescription: "Characters allowed in a note. A note belongs to one Thread, so it may lean on that Thread's manual.",
    saveNotes: "Save limits",
    saveNotesError: "Could not save the note limits",
    notesInvalid: "Enter a whole number between 1 and 2000.",
    loadError: "Could not load settings",
    retry: "Retry",
    checkingAccess: "Checking administrator access…",
    accessError: "Could not verify administrator access",
    required: "Administrator access is required to view and change system configuration.",
  },
  zh: {
    experimentalFeatures: "实验性功能",
    experimentalFeaturesDescription: "控制所有请求的实验性行为。",
    threadIdHeader: "发送 Thread ID 请求头",
    threadIdHeaderDescription: "向所有线程和 API 客户端的上游 Responses 请求添加 thread-id: <UUID>。",
    sessionIdHeader: "发送 Session ID 请求头",
    sessionIdHeaderDescription: "向所有线程和 API 客户端的上游 Responses 请求添加 session-id: <Thread ID>。默认关闭，独立于 Thread ID 请求头开关。",
    saveExperimentalError: "无法保存实验性功能设置",
    notesTitle: "便签",
    notesDescription: "服务在添加便签时执行的字符上限。超长会被拒绝并提示模型精简内容，因此便签会被重写，而不是被静默截断。",
    threadMaxChars: "便签上限",
    threadMaxCharsDescription: "每条便签允许的字符数。便签只属于一个线程，因此可以依赖该线程的上下文。",
    saveNotes: "保存上限",
    saveNotesError: "无法保存便签上限",
    notesInvalid: "请输入 1 到 2000 之间的整数。",
    loadError: "无法加载配置",
    retry: "重试",
    checkingAccess: "正在确认管理员权限…",
    accessError: "无法确认管理员权限",
    required: "仅管理员可查看和修改系统配置。",
  },
} as const

function SettingsError({ error, title, retryLabel, onRetry }: { error: Error; title: string; retryLabel: string; onRetry: () => void }) {
  return <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{title}</AlertTitle><AlertDescription className="flex flex-wrap items-center justify-between gap-3"><span className="break-words">{error.message}</span><Button size="sm" variant="outline" onClick={onRetry}>{retryLabel}</Button></AlertDescription></Alert>
}

export function SystemConfiguration({ language, sessionId, request }: Props) {
  const t = copy[language]
  const access = useQuery({
    queryKey: ["me", sessionId],
    queryFn: ({ signal }) => request<{ is_admin: boolean }>("/api/me", { signal }),
    staleTime: 60_000,
  })
  if (access.isPending) return <div role="status" className="flex flex-col gap-3"><p className="text-sm text-muted-foreground">{t.checkingAccess}</p><Skeleton className="h-36" /></div>
  if (access.error) return <SettingsError error={access.error} title={t.accessError} retryLabel={t.retry} onRetry={() => void access.refetch()} />
  if (access.data?.is_admin !== true) return <Alert><AlertTitle>{t.required}</AlertTitle></Alert>
  return <div className="flex flex-col gap-4">
    <ExperimentalFeaturesCard language={language} sessionId={sessionId} request={request} />
    <NoteLimitsCard language={language} sessionId={sessionId} request={request} />
  </div>
}

function ExperimentalFeaturesCard({ language, sessionId, request }: Props) {
  const t = copy[language]
  const client = useQueryClient()
  const queryKey = ["system-configuration", sessionId, "experimental-features"]
  const features = useQuery({ queryKey, queryFn: ({ signal }) => request<ExperimentalFeatures>("/api/experimental-features", { signal }) })
  const save = useMutation({
    mutationFn: (value: Partial<ExperimentalFeatures>) => request<ExperimentalFeatures>("/api/experimental-features", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: (value) => client.setQueryData(queryKey, value),
  })
  return <Card><CardHeader><CardTitle>{t.experimentalFeatures}</CardTitle><CardDescription>{t.experimentalFeaturesDescription}</CardDescription></CardHeader><CardContent>
    {features.error && <SettingsError error={features.error} title={t.loadError} retryLabel={t.retry} onRetry={() => void features.refetch()} />}
    {features.isPending && <Skeleton className="h-36 max-w-xl" />}
    {features.data && <FieldGroup className="max-w-xl"><Field orientation="horizontal" data-disabled={save.isPending}>
      <FieldContent><FieldLabel htmlFor="experimental-thread-id-header">{t.threadIdHeader}</FieldLabel><FieldDescription id="experimental-thread-id-header-description">{t.threadIdHeaderDescription}</FieldDescription></FieldContent>
      <Switch id="experimental-thread-id-header" aria-describedby="experimental-thread-id-header-description" checked={features.data.thread_id_header} disabled={save.isPending} onCheckedChange={(thread_id_header) => save.mutate({ thread_id_header })} />
    </Field><Field orientation="horizontal" data-disabled={save.isPending}>
      <FieldContent><FieldLabel htmlFor="experimental-session-id-header">{t.sessionIdHeader}</FieldLabel><FieldDescription id="experimental-session-id-header-description">{t.sessionIdHeaderDescription}</FieldDescription></FieldContent>
      <Switch id="experimental-session-id-header" aria-describedby="experimental-session-id-header-description" checked={features.data.session_id_header} disabled={save.isPending} onCheckedChange={(session_id_header) => save.mutate({ session_id_header })} />
    </Field></FieldGroup>}
    {save.error && <Alert className="mt-4" variant="destructive"><CircleAlertIcon /><AlertTitle>{t.saveExperimentalError}</AlertTitle><AlertDescription>{save.error.message}</AlertDescription></Alert>}
  </CardContent></Card>
}

// The note limits are service configuration, not a database constraint: an add
// past the limit is refused with a message the model can act on, so the note is
// rewritten short instead of being silently truncated on the way in.
function NoteLimitsCard({ language, sessionId, request }: Props) {
  const t = copy[language]
  const client = useQueryClient()
  const queryKey = ["system-configuration", sessionId, "note-settings"]
  const settings = useQuery({ queryKey, queryFn: ({ signal }) => request<NoteSettings>("/api/note-settings", { signal }) })
  const [draft, setDraft] = useState<NoteSettings | null>(null)
  const save = useMutation({
    mutationFn: (value: NoteSettings) => request<NoteSettings>("/api/note-settings", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: (value) => { client.setQueryData(queryKey, value); setDraft(null) },
  })
  const value = draft ?? settings.data ?? null
  const valid = value !== null
    && Number.isInteger(value.thread_max_chars) && value.thread_max_chars >= 1 && value.thread_max_chars <= NOTE_CHAR_CEILING
  const change = (key: keyof NoteSettings) => (event: ChangeEvent<HTMLInputElement>) => {
    const next = Number.parseInt(event.target.value, 10)
    if (value !== null) setDraft({ ...value, [key]: Number.isNaN(next) ? 0 : next })
  }
  return <Card><CardHeader><CardTitle>{t.notesTitle}</CardTitle><CardDescription>{t.notesDescription}</CardDescription></CardHeader><CardContent>
    {settings.error && <SettingsError error={settings.error} title={t.loadError} retryLabel={t.retry} onRetry={() => void settings.refetch()} />}
    {settings.isPending && <Skeleton className="h-36 max-w-xl" />}
    {value !== null && <FieldGroup className="max-w-xl">
      <Field orientation="horizontal">
        <FieldContent><FieldLabel htmlFor="note-thread-max-chars">{t.threadMaxChars}</FieldLabel><FieldDescription id="note-thread-max-chars-description">{t.threadMaxCharsDescription}</FieldDescription></FieldContent>
        <Input id="note-thread-max-chars" aria-describedby="note-thread-max-chars-description" className="w-28" type="number" min={1} max={NOTE_CHAR_CEILING} value={value.thread_max_chars} disabled={save.isPending} onChange={change("thread_max_chars")} />
      </Field>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!valid || save.isPending || draft === null} onClick={() => { if (value !== null) save.mutate(value) }}>{save.isPending ? <Spinner /> : null}{t.saveNotes}</Button>
        {!valid && <span className="text-xs text-destructive">{t.notesInvalid}</span>}
      </div>
    </FieldGroup>}
    {save.error && <Alert className="mt-4" variant="destructive"><CircleAlertIcon /><AlertTitle>{t.saveNotesError}</AlertTitle><AlertDescription>{save.error.message}</AlertDescription></Alert>}
  </CardContent></Card>
}
