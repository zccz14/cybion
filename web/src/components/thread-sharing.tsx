import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CopyIcon, Share2Icon } from "lucide-react"
import { LinkitUserPicker } from "linkit-react-components"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { recipientError } from "@/lib/worker-sharing"
import { sharedThreadPath, type SharingRequest, type ThreadGrant } from "@/lib/thread-sharing"

const copy = {
  en: {
    share: "Share Thread", shared: "Shared", unknown: "Sharing status unavailable", title: "Share Thread", description: "Only signed-in users you authorize can open this link. Forwarding it does not grant access.",
    recipient: "Recipient", hint: "Search the Linkit directory by username or UUID. If the recipient has never signed in to Cybion, their account is created silently; no invitation is sent.",
    warning: "Shares all existing history and future updates, including tool output, screenshots and Context content already recorded here. Sensitive content in the conversation is not automatically redacted. This does not grant device, model or Context access.",
    consent: "I confirm this user may read the entire Thread and future updates.", grant: "Authorize viewing", self: "You already own this Thread. Choose another user.",
    recipients: "People with access", empty: "No access granted yet.", viewer: "Can view", revoked: "Revoked", pending: "Authorized; list sync pending", revocationPending: "Revoked; list sync pending", revoke: "Revoke access", retry: "Retry", loading: "Loading access…",
    revokeConfirm: "Revoke access for {uid}? Future reads will be blocked. Previously read or copied content cannot be recalled. Your running task will continue.",
    copy: "Copy access link", copied: "Link copied", copyFailed: "Could not copy. Select and copy the link below.",
    uid: "My user ID", uidHint: "Send this ID to the Thread owner to receive a share.", copyUid: "Copy user ID", uidCopied: "User ID copied",
    ongoing: "New messages in this Thread are also shared.", owner: "You · Owner",
  },
  zh: {
    share: "分享 Thread", shared: "已分享", unknown: "分享状态暂不可用", title: "分享 Thread", description: "只有已登录且获得授权的用户可以访问此链接。转发链接不会授予访问权限。",
    recipient: "接收者", hint: "在 Linkit 目录中按用户名或 UUID 搜索。若接收者从未登录过 Cybion，将静默创建其账号；不会发送邀请。",
    warning: "分享全部已有历史和后续更新，包括工具输出、截图和已记录的 Context 内容。会话中的敏感内容不会自动脱敏；不会授予设备、模型或 Context 的使用权限。",
    consent: "我确认此用户可以查看整条 Thread 及后续更新。", grant: "授权查看", self: "你已拥有此 Thread，请选择其他用户。",
    recipients: "拥有访问权限", empty: "尚未授予访问权限。", viewer: "可查看", revoked: "已撤销", pending: "已授权，列表同步中", revocationPending: "已撤销，列表同步中", revoke: "撤销访问", retry: "重试", loading: "正在加载权限…",
    revokeConfirm: "撤销 {uid} 的访问权限？后续读取将被阻止，已经阅读或复制的内容无法收回。你正在运行的任务不会停止。",
    copy: "复制访问链接", copied: "已复制链接", copyFailed: "复制失败，请手动选择并复制下方链接。",
    uid: "我的用户 ID", uidHint: "将此 ID 发给 Thread 所有者，由对方授权分享。", copyUid: "复制用户 ID", uidCopied: "已复制用户 ID",
    ongoing: "此 Thread 的后续消息也会分享给对方。", owner: "你 · 所有者",
  },
} satisfies Record<"en" | "zh", Record<string, string>>

export function SharingError({ error, retry, language }: { error: unknown; retry?: () => void; language: "en" | "zh" }) {
  return <Alert variant="destructive"><AlertDescription className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-words">{error instanceof Error ? error.message : String(error)}</span>{retry && <Button type="button" size="sm" variant="outline" onClick={retry}>{copy[language].retry}</Button>}</AlertDescription></Alert>
}

export function SharingUserId({ userId, language }: { userId: string; language: "en" | "zh" }) {
  const t = copy[language]
  const [status, setStatus] = useState("")
  return <section aria-label={t.uid} className="flex flex-col gap-2 rounded-xl border p-3">
    <p className="text-sm font-medium">{t.uid}</p><p className="text-xs text-muted-foreground">{t.uidHint}</p>
    <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs">{userId}</code><Button size="sm" variant="outline" aria-label={t.copyUid} onClick={async () => { try { await navigator.clipboard.writeText(userId); setStatus(t.uidCopied) } catch { setStatus(t.copyFailed) } }}><CopyIcon /></Button></div>
    <p role="status" className="text-xs text-muted-foreground">{status}</p>
  </section>
}

type Props = { userId: string; sessionId: string | null | undefined; threadId: string; language: "en" | "zh"; request: SharingRequest }
export function ThreadSharingButton(props: Props) {
  return <ThreadSharingControl key={`${props.sessionId}:${props.userId}:${props.threadId}`} {...props} />
}
function ThreadSharingControl({ userId, sessionId, threadId, language, request }: Props) {
  const t = copy[language]
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [recipient, setRecipient] = useState("")
  const [consent, setConsent] = useState(false)
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null)
  const key = ["thread-grants", sessionId, userId, threadId]
  const path = `/api/threads/${encodeURIComponent(threadId)}/grants`
  const grants = useQuery({ queryKey: key, queryFn: ({ signal }) => request<ThreadGrant[]>(path, { signal, cache: "no-store" }), retry: false, refetchInterval: 2500, gcTime: 0 })
  const grant = useMutation({ mutationFn: (uid: string) => request<ThreadGrant>(`${path}/${encodeURIComponent(uid)}`, { method: "PUT" }), onSuccess: (value) => {
    client.setQueryData<ThreadGrant[]>(key, (old) => [...(old ?? []).filter((g) => g.grantee_user_id !== value.grantee_user_id), value])
    setConsent(false); void client.invalidateQueries({ queryKey: key })
  } })
  const revoke = useMutation({ mutationFn: (uid: string) => request<void>(`${path}/${encodeURIComponent(uid)}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: key }) })
  const invalid = recipientError(recipient, userId)
  const active = grants.data?.filter((g) => g.revoked_at === null).length ?? 0
  const busy = grant.isPending || revoke.isPending
  const link = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}#${sharedThreadPath(userId, threadId)}`
  const error = grants.error || grant.error || revoke.error
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild>
    <Button variant={active ? "secondary" : "outline"} size="sm" title={active ? t.ongoing : t.description}>
      <Share2Icon />{grants.error ? t.unknown : active ? `${t.shared} · ${active}` : t.share}
    </Button></DialogTrigger>
    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{t.title}</DialogTitle><DialogDescription>{t.description}</DialogDescription></DialogHeader>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (recipient && !invalid && consent && !busy) grant.mutate(recipient) }}>
        <Field data-invalid={Boolean(invalid)}>
          <LinkitUserPicker lang={language === "zh" ? "zh-CN" : "en-US"} label={t.recipient} value={recipient} onValueChange={(next) => { setRecipient(next); setConsent(false); grant.reset() }} />
          <FieldDescription>{t.hint}</FieldDescription>
          <p role="status" className="text-xs text-destructive">{invalid ? t.self : ""}</p>
        </Field>
        <Alert><AlertDescription>{t.warning}</AlertDescription></Alert>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{t.consent}</label>
        <Button className="self-start" disabled={!recipient || Boolean(invalid) || !consent || busy}>{grant.isPending && <Spinner />}{t.grant}</Button>
      </form>
      {error && <SharingError error={error} language={language} retry={grants.error ? () => void grants.refetch() : undefined} />}
      <h3 className="text-sm font-medium">{t.recipients}</h3><p className="text-sm text-muted-foreground">{t.owner}</p>
      {grants.isPending && <p role="status">{t.loading}</p>}{grants.data?.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      <ul className="divide-y">{grants.data?.map((g) => <li key={g.grant_id} className="flex flex-wrap items-center gap-2 py-3"><code className="min-w-0 basis-full break-all text-xs sm:flex-1 sm:basis-auto">{g.grantee_user_id}</code><Badge variant="outline">{g.revoked_at === null ? t.viewer : t.revoked}</Badge>{g.revision !== g.synced_revision && <span className="text-xs text-muted-foreground">{g.revoked_at === null ? t.pending : t.revocationPending}</span>}{g.revoked_at === null && <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(t.revokeConfirm.replace("{uid}", g.grantee_user_id))) revoke.mutate(g.grantee_user_id) }}>{t.revoke}</Button>}</li>)}</ul>
      <Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopyStatus("copied") } catch { setCopyStatus("failed") } }}><CopyIcon />{t.copy}</Button>
      {copyStatus && <p role="status" className="text-xs text-muted-foreground">{copyStatus === "copied" ? t.copied : t.copyFailed}</p>}
      {copyStatus === "failed" && <Input aria-label={t.copy} readOnly value={link} onFocus={(event) => event.target.select()} />}
    </DialogContent></Dialog>
}
