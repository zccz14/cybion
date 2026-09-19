import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLinkIcon, RefreshCwIcon, SendIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { formattedTime } from "@/lib/time"

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Status = {
  enabled: boolean
  configured: boolean
  bot_id: string | null
  recipient_username: string | null
  last_attempt_at: number | null
  last_success_at: number | null
  last_error: string | null
  conversation_id: string | null
  message_id: string | null
}
type Receipt = { id: string; conversation_id: string; sender_id: string; sender_kind: string }

const copy = {
  en: {
    title: "Linkit task notifications (optional)",
    description: "Send completion and failure messages to your own Linkit conversation. Notifications are independent of model inference and OpenAI-LB refresh.",
    enabled: "Enabled", paused: "Paused", unconfigured: "Not configured", recipient: "Recipient", bot: "Bot",
    configure: "Enable or repair notifications", test: "Send test notification", pause: "Pause automatic notifications",
    empty: "No recorded delivery. Send a test to verify this channel.",
    lastAttempt: "Last attempt", lastSuccess: "Last delivered to Linkit", latestError: "Latest delivery error",
    delivered: "Test message delivered to Linkit.", open: "Open Linkit conversation", message: "Message ID",
    boundary: "Delivery confirms the message is stored in Linkit, not device push or read status. A manual test does not enable paused notifications.",
  },
  zh: {
    title: "Linkit 任务通知（可选）",
    description: "将任务完成和失败消息发送到你自己的 Linkit 会话。通知独立于模型推理和 OpenAI-LB 刷新。",
    enabled: "已开启", paused: "已暂停", unconfigured: "未开通", recipient: "接收者", bot: "机器人",
    configure: "开通或修复通知", test: "发送测试通知", pause: "暂停自动通知",
    empty: "尚无投递记录。请发送测试通知验证这条通道。",
    lastAttempt: "最近尝试", lastSuccess: "最近成功投递到 Linkit", latestError: "最近投递错误",
    delivered: "测试消息已投递到 Linkit。", open: "打开 Linkit 会话", message: "消息 ID",
    boundary: "投递成功表示消息已存入 Linkit，不代表设备推送或已读。手动测试不会开启已暂停的自动通知。",
  },
} as const

export function LinkitNotifications({ request, language, sessionId }: { request: Request; language: "en" | "zh"; sessionId?: string | null }) {
  const t = copy[language]
  const client = useQueryClient()
  const key = ["linkit-notifications", sessionId]
  const status = useQuery({ queryKey: key, queryFn: () => request<Status>("/api/integrations/linkit"), refetchInterval: 10000 })
  const configure = useMutation({ mutationFn: () => request<Status>("/api/integrations/linkit/refresh", { method: "POST" }), onSuccess: (value) => client.setQueryData(key, value) })
  const pause = useMutation({ mutationFn: () => request<Status>("/api/integrations/linkit", { method: "DELETE" }), onSuccess: (value) => client.setQueryData(key, value) })
  const test = useMutation({ mutationFn: () => request<Receipt>("/api/integrations/linkit/test", { method: "POST" }), onSettled: () => client.invalidateQueries({ queryKey: key }) })
  const busy = configure.isPending || pause.isPending || test.isPending
  const error = status.error || configure.error || pause.error || test.error
  const data = status.data
  return <Card data-testid="linkit-notifications"><CardHeader><CardTitle>{t.title}</CardTitle><CardDescription>{t.description}</CardDescription></CardHeader><CardContent className="space-y-4">
    {data && <>
      <div className="flex flex-wrap items-center gap-3"><Badge variant="outline">{!data.configured ? t.unconfigured : data.enabled ? t.enabled : t.paused}</Badge><span className="text-sm">{t.recipient}: {data.recipient_username ? `@${data.recipient_username}` : "—"}</span></div>
      {data.bot_id && <p className="break-all text-xs text-muted-foreground">{t.bot}: <code>{data.bot_id}</code></p>}
      {data.last_attempt_at === null ? <p className="text-sm text-muted-foreground">{t.empty}</p> : <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t.lastAttempt}</dt><dd>{formattedTime(language, data.last_attempt_at)}</dd></div><div><dt className="text-muted-foreground">{t.lastSuccess}</dt><dd>{formattedTime(language, data.last_success_at)}</dd></div></dl>}
      {data.last_error && <p role="alert" className="break-words text-sm text-destructive">{t.latestError}: {data.last_error}</p>}
      {data.conversation_id && <div className="space-y-1"><a className="inline-flex items-center gap-1 text-sm text-primary hover:underline" href={`https://linkit.ntnl.io/#/conversations/${encodeURIComponent(data.conversation_id)}`} target="_blank" rel="noopener noreferrer">{t.open}<ExternalLinkIcon className="size-3" /></a><p className="break-all text-xs text-muted-foreground">{t.message}: <code>{data.message_id}</code></p></div>}
    </>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { test.reset(); pause.reset(); configure.mutate() }}>{configure.isPending ? <Spinner /> : <RefreshCwIcon data-icon="inline-start" />}{t.configure}</Button><Button variant="outline" disabled={busy || !data?.configured} onClick={() => { configure.reset(); pause.reset(); test.mutate() }}>{test.isPending ? <Spinner /> : <SendIcon data-icon="inline-start" />}{t.test}</Button>{data?.enabled && <Button variant="ghost" disabled={busy} onClick={() => { test.reset(); configure.reset(); pause.mutate() }}>{t.pause}</Button>}</div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error.message}</p>}
    {test.isSuccess && <p role="status" className="text-sm">{t.delivered}</p>}
    <p className="text-xs text-muted-foreground">{t.boundary}</p>
  </CardContent></Card>
}
