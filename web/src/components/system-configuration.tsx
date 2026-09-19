import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
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
type ExperimentalFeatures = { thread_id_header: boolean; session_id_header: boolean; codex_turn_state_header: boolean }
type RequestHeaders = { user_agent: string; originator: string }
const copy = {
  en: {
    experimentalFeatures: "Experimental features",
    experimentalFeaturesDescription: "Global controls for experimental request behavior.",
    threadIdHeader: "Send Thread ID header",
    threadIdHeaderDescription: "Add thread-id: <UUID> to upstream Responses requests for every thread and API client.",
    sessionIdHeader: "Send Session ID header",
    sessionIdHeaderDescription: "Add session-id: <Thread ID> to upstream Responses requests for every thread and API client. Disabled by default and independent of the Thread ID header switch.",
    codexTurnStateHeader: "Return x-codex-turn-state header",
    codexTurnStateHeaderDescription: "Save the latest x-codex-turn-state response header per thread and send it with subsequent requests. Disabled by default.",
    saveExperimentalError: "Could not save experimental feature settings",
    requestHeaders: "Request headers",
    requestHeadersDescription: "Administrator-only global headers sent with every upstream Responses request.",
    userAgent: "User-Agent",
    userAgentDescription: "Leave blank to use Cybion's default User-Agent.",
    originator: "Originator",
    originatorDescription: "Optional originator value sent to the upstream service.",
    saveRequestHeaders: "Save request headers",
    savingRequestHeaders: "Saving…",
    requestHeadersSaved: "Request headers saved",
    saveRequestHeadersError: "Could not save request headers",
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
    codexTurnStateHeader: "回传 x-codex-turn-state 请求头",
    codexTurnStateHeaderDescription: "为每个 Thread 缓存最新的 x-codex-turn-state 响应头，并在后续请求中回传。默认关闭。",
    saveExperimentalError: "无法保存实验性功能设置",
    requestHeaders: "请求头",
    requestHeadersDescription: "管理员专用的全局请求头，会发送到所有上游 Responses 请求。",
    userAgent: "User-Agent",
    userAgentDescription: "留空则使用 Cybion 默认 User-Agent。",
    originator: "Originator",
    originatorDescription: "发送给上游服务的可选 originator 值。",
    saveRequestHeaders: "保存请求头",
    savingRequestHeaders: "保存中…",
    requestHeadersSaved: "请求头已保存",
    saveRequestHeadersError: "无法保存请求头",
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
  return <>
    <ExperimentalFeaturesCard language={language} sessionId={sessionId} request={request} />
    <RequestHeadersCard language={language} sessionId={sessionId} request={request} />
  </>
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
    </Field><Field orientation="horizontal" data-disabled={save.isPending}>
      <FieldContent><FieldLabel htmlFor="experimental-codex-turn-state-header">{t.codexTurnStateHeader}</FieldLabel><FieldDescription id="experimental-codex-turn-state-header-description">{t.codexTurnStateHeaderDescription}</FieldDescription></FieldContent>
      <Switch id="experimental-codex-turn-state-header" aria-describedby="experimental-codex-turn-state-header-description" checked={features.data.codex_turn_state_header} disabled={save.isPending} onCheckedChange={(codex_turn_state_header) => save.mutate({ codex_turn_state_header })} />
    </Field></FieldGroup>}
    {save.error && <Alert className="mt-4" variant="destructive"><CircleAlertIcon /><AlertTitle>{t.saveExperimentalError}</AlertTitle><AlertDescription>{save.error.message}</AlertDescription></Alert>}
  </CardContent></Card>
}

function RequestHeadersCard({ language, sessionId, request }: Props) {
  const t = copy[language]
  const client = useQueryClient()
  const queryKey = ["system-configuration", sessionId, "request-headers"]
  const headers = useQuery({ queryKey, queryFn: ({ signal }) => request<RequestHeaders>("/api/integrations", { signal }) })
  const [draft, setDraft] = useState<RequestHeaders | null>(null)
  const value = draft ?? headers.data
  const changed = value && headers.data && (value.user_agent !== headers.data.user_agent || value.originator !== headers.data.originator)
  const save = useMutation({
    mutationFn: (next: RequestHeaders) => request<RequestHeaders>("/api/integrations", { method: "PUT", body: JSON.stringify(next) }),
    onSuccess: (saved) => { setDraft(null); client.setQueryData(queryKey, saved) },
  })
  const edit = (next: RequestHeaders) => { setDraft(next); save.reset() }
  return <Card><CardHeader><CardTitle>{t.requestHeaders}</CardTitle><CardDescription>{t.requestHeadersDescription}</CardDescription></CardHeader><CardContent>
    {headers.error && <SettingsError error={headers.error} title={t.loadError} retryLabel={t.retry} onRetry={() => void headers.refetch()} />}
    {headers.isPending && <Skeleton className="h-48 max-w-xl" />}
    {value && <form className="flex max-w-xl flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (changed && !save.isPending) save.mutate({ user_agent: value.user_agent, originator: value.originator }) }}>
      <FieldGroup>
        <Field data-disabled={save.isPending}><FieldLabel htmlFor="system-user-agent">{t.userAgent}</FieldLabel><Input id="system-user-agent" value={value.user_agent} disabled={save.isPending} onChange={(event) => edit({ user_agent: event.target.value, originator: value.originator })} /><FieldDescription>{t.userAgentDescription}</FieldDescription></Field>
        <Field data-disabled={save.isPending}><FieldLabel htmlFor="system-originator">{t.originator}</FieldLabel><Input id="system-originator" value={value.originator} disabled={save.isPending} onChange={(event) => edit({ user_agent: value.user_agent, originator: event.target.value })} /><FieldDescription>{t.originatorDescription}</FieldDescription></Field>
      </FieldGroup>
      {save.error && <Alert variant="destructive"><CircleAlertIcon /><AlertTitle>{t.saveRequestHeadersError}</AlertTitle><AlertDescription>{save.error.message}</AlertDescription></Alert>}
      <div className="flex flex-wrap items-center gap-3"><Button disabled={!changed || save.isPending}>{save.isPending ? <Spinner /> : <CheckIcon data-icon="inline-start" />}{save.isPending ? t.savingRequestHeaders : t.saveRequestHeaders}</Button><p role="status" className="text-sm text-muted-foreground">{save.isSuccess && t.requestHeadersSaved}</p></div>
    </form>}
  </CardContent></Card>
}
