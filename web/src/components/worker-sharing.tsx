import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { recipientError, type WorkerGrant } from "@/lib/worker-sharing"

type Props = {
  language: "zh" | "en"
  request: <T>(path: string, init?: RequestInit) => Promise<T>
  sessionId: string | null | undefined
  userId: string | undefined
  workerId: string
}
const copy = {
  en: {
    title: "Share access", recipient: "Recipient user ID", hint: "The recipient must have used Cybion already. Ask them to copy their user ID from the devices page. Paste that exact ID here; no invitation is sent.",
    risk: "Grants bash, browser control and desktop control. Remote commands run with the Worker's OS account, without a sandbox. The browser and desktop are shared. The owner can audit commands and results. Credentials and private Threads are not shared.",
    consent: "I trust this user with this device and understand these risks.", grant: "Grant access", required: "Enter a recipient user ID.", self: "You already own this device. Enter another user's ID.", exact: "Paste the exact user ID without spaces.",
    recipients: "Recipients", empty: "No access granted yet.", active: "Active", revoked: "Revoked", pending: "Propagation pending", synced: "Synced", revoke: "Revoke access", retry: "Retry", loading: "Loading recipients…",
    revokeConfirm: "Revoke access for {uid}? Queued and future calls will be blocked. Commands that have already started may continue.",
  },
  zh: {
    title: "共享访问", recipient: "接收者用户 ID", hint: "对方必须已使用过 Cybion。请让对方从设备页面复制用户 ID，并在此粘贴完整 ID；不会发送邀请。",
    risk: "授权包含命令执行、浏览器控制和桌面操作。远程命令以 Worker 的系统账户运行，没有沙箱；浏览器和桌面也会共享。设备所有者可以审计命令和结果。不会共享凭证或私有 Thread。",
    consent: "我信任此用户使用这台设备，并理解上述风险。", grant: "授予访问", required: "请输入接收者用户 ID。", self: "你已拥有此设备，请填写其他用户的 ID。", exact: "请粘贴不含空格的完整用户 ID。",
    recipients: "接收者", empty: "尚未授予访问权限。", active: "有效", revoked: "已撤销", pending: "等待同步", synced: "已同步", revoke: "撤销访问", retry: "重试", loading: "正在加载接收者…",
    revokeConfirm: "撤销 {uid} 的访问权限？排队中和后续调用将被阻止，已经开始的命令可能继续运行。",
  },
}
export function WorkerSharing({ language, request, sessionId, userId, workerId }: Props) {
  const t = copy[language]
  const client = useQueryClient()
  const inputId = useId()
  const [recipient, setRecipient] = useState("")
  const [consent, setConsent] = useState(false)
  const key = ["worker-grants", sessionId, workerId]
  const path = `/api/workers/${encodeURIComponent(workerId)}/grants`
  const grants = useQuery({ queryKey: key, queryFn: ({ signal }) => request<WorkerGrant[]>(path, { signal }), retry: false, refetchInterval: 3000 })
  const grant = useMutation({
    mutationFn: (uid: string) => request<WorkerGrant>(`${path}/${encodeURIComponent(uid)}`, { method: "PUT" }),
    onSuccess: (value) => {
      client.setQueryData<WorkerGrant[]>(key, (previous) => [...(previous ?? []).filter((item) => item.grantee_user_id !== value.grantee_user_id), value])
      setConsent(false)
      void client.invalidateQueries({ queryKey: key })
      void client.invalidateQueries({ queryKey: ["workers", sessionId] })
    },
  })
  const revoke = useMutation({
    mutationFn: (uid: string) => request<void>(`${path}/${encodeURIComponent(uid)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key })
      void client.invalidateQueries({ queryKey: ["workers", sessionId] })
    },
  })
  const invalid = recipientError(recipient, userId)
  const busy = grant.isPending || revoke.isPending
  const error = grants.error || grant.error || revoke.error
  return <section aria-label={t.title} className="mt-4 flex flex-col gap-4 border-t pt-4">
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (!invalid && consent && userId && !busy) grant.mutate(recipient) }}>
      <Field data-invalid={Boolean(recipient && invalid)}>
        <FieldLabel htmlFor={inputId}>{t.recipient}</FieldLabel>
        <Input id={inputId} value={recipient} autoComplete="off" spellCheck={false} aria-invalid={Boolean(recipient && invalid)} aria-describedby={`${inputId}-hint ${inputId}-validation`} onChange={(event) => { setRecipient(event.target.value); setConsent(false); grant.reset() }} />
        <FieldDescription id={`${inputId}-hint`}>{t.hint}</FieldDescription>
        <p id={`${inputId}-validation`} role="status" className="text-xs text-destructive">{recipient && invalid ? t[invalid] : ""}</p>
      </Field>
      <Alert><AlertDescription>{t.risk}</AlertDescription></Alert>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{t.consent}</label>
      <Button className="self-start" disabled={Boolean(invalid) || !consent || !userId || busy}>{grant.isPending && <Spinner />}{t.grant}</Button>
    </form>
    {error && <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert>}
    {grants.error && <Button className="self-start" variant="outline" onClick={() => void grants.refetch()}>{t.retry}</Button>}
    <h3 className="text-sm font-medium">{t.recipients}</h3>
    {grants.isPending && <p role="status" className="text-sm text-muted-foreground">{t.loading}</p>}
    {grants.data?.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
    <ul className="divide-y">{grants.data?.map((item) => <li key={item.grant_id} className="flex flex-wrap items-center gap-2 py-3">
      <code className="min-w-0 basis-full break-all text-xs sm:flex-1 sm:basis-auto">{item.grantee_user_id}</code>
      <Badge variant="outline">{item.revoked_at === null ? t.active : t.revoked}</Badge>
      <Badge variant="secondary">{item.revision !== item.synced_revision ? t.pending : t.synced}</Badge>
      {item.revoked_at === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(t.revokeConfirm.replace("{uid}", item.grantee_user_id))) revoke.mutate(item.grantee_user_id) }}>{t.revoke}</Button>}
    </li>)}</ul>
  </section>
}
