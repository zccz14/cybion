import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckIcon, CopyIcon, KeyRoundIcon, RadioIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { formattedTime } from "@zccz14/cybion-components/logic"

type Language = "zh" | "en"
type Request = <T>(path: string, init?: RequestInit) => Promise<T>

export type ExeDevice = { worker_id: string; label: string; address: string; status: "online" | "offline"; last_seen_at: number | null; platform?: string | null; version?: string | null; created_at: number }
export type ExeIdentity = { address: string; created_at: number; devices: ExeDevice[] }

const copy = {
  zh: {
    title: "eXe 设备", description: "eXe 设备不用安装 Cybion Worker:给它一个地址,它就把结果送回这里。命令与结果在 Cybion 云端签名、加解密,中继只搬运密封的信封。",
    address: "本账号地址 (公钥)", addressHint: "私钥保存在 Cybion 云端,不会显示,也无法导出。在任何一台 eXe 设备上执行下面的命令,这台设备就信任了本账号:",
    trust: "在设备上执行", add: "接入设备", addressLabel: "设备地址", addressPlaceholder: "设备上 exe status 显示的那行地址", name: "设备名称 (可选)",
    connect: "接入", empty: "还没有接入 eXe 设备。", online: "在线", offline: "离线", lastSeen: "最后在线", never: "从未上线",
    remove: "移除", removeConfirm: "移除后这台设备仍会信任本账号地址,但 Cybion 不再向它派发任务。确认移除?", copied: "已复制", copyFailed: "复制失败,请手动选择复制。", copy: "复制",
    onlyShell: "eXe 设备只执行 shell 命令;浏览器控制、桌面操作与看图请使用 Cybion Worker。",
    invalid: "设备地址应为 32 字节公钥的 base58 形式 (43–44 个字符)。", retry: "重试",
  },
  en: {
    title: "eXe devices", description: "An eXe device needs no Cybion Worker: give it an address and it sends its results back here. Commands and results are signed and sealed in the Cybion cloud; the relay only moves sealed envelopes.",
    address: "This account's address (public key)", addressHint: "The private key stays in the Cybion cloud. It is never shown and cannot be exported. Run this on any eXe device to let it trust this account:",
    trust: "Run on the device", add: "Connect a device", addressLabel: "Device address", addressPlaceholder: "the address `exe status` prints on the device", name: "Device name (optional)",
    connect: "Connect", empty: "No eXe device connected yet.", online: "Online", offline: "Offline", lastSeen: "Last seen", never: "Never seen",
    remove: "Remove", removeConfirm: "The device keeps trusting this account's address, but Cybion stops dispatching to it. Remove it?", copied: "Copied", copyFailed: "Copy failed; select the text and copy it manually.", copy: "Copy",
    onlyShell: "An eXe device runs shell commands only; browser control, desktop control and image reading need a Cybion Worker.",
    invalid: "A device address is the base58 form of a 32-byte public key (43–44 characters).", retry: "Retry",
  },
} satisfies Record<Language, Record<string, string>>

function AddressBlock({ address, language }: { address: string; language: Language }) {
  const t = copy[language]
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  useEffect(() => setStatus("idle"), [address])
  return <div className="space-y-2">
    <div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3">
      <code className="min-w-0 flex-1 break-all text-xs leading-6">{address}</code>
      <Button size="icon-sm" variant="outline" aria-label={t.copy} onClick={async () => { try { await navigator.clipboard.writeText(address); setStatus("copied") } catch { setStatus("failed") } }}>{status === "copied" ? <CheckIcon /> : <CopyIcon />}</Button>
    </div>
    <p role="status" className="text-xs text-muted-foreground">{status === "copied" ? t.copied : status === "failed" ? t.copyFailed : ""}</p>
  </div>
}

function validAddress(value: string) { return /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value.trim()) }

export function ExeDevices({ language, request, sessionId }: { language: Language; request: Request; sessionId: string | null | undefined }) {
  const t = copy[language]
  const client = useQueryClient()
  const [address, setAddress] = useState("")
  const [label, setLabel] = useState("")
  const key = ["exe", sessionId]
  const identity = useQuery({ queryKey: key, queryFn: ({ signal }) => request<ExeIdentity>("/api/exe", { signal }), refetchInterval: 15000 })
  const connect = useMutation({ mutationFn: () => request<ExeDevice>("/api/exe/devices", { method: "POST", body: JSON.stringify({ address: address.trim(), label: label.trim() || undefined }) }), onSuccess: () => { setAddress(""); setLabel(""); void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ["workers", sessionId] }) } })
  const remove = useMutation({ mutationFn: (id: string) => request(`/api/workers/${id}`, { method: "DELETE" }), onSuccess: () => { void client.invalidateQueries({ queryKey: key }); void client.invalidateQueries({ queryKey: ["workers", sessionId] }) } })
  const error = connect.error || remove.error
  // A payload missing `devices` is a Controller that does not serve the list
  // yet: show the address and nothing else rather than failing the page.
  const devices = identity.data?.devices ?? []
  const command = identity.data?.address ? `exe trust ${identity.data.address}` : ""
  return <Card role="region" aria-label={t.title}><CardHeader><CardTitle className="flex items-center gap-2"><RadioIcon className="size-4" />{t.title}</CardTitle><CardDescription>{t.description}</CardDescription></CardHeader><CardContent className="space-y-4">
    <div className="space-y-2"><p className="text-sm font-medium">{t.address}</p><p className="text-xs leading-5 text-muted-foreground">{t.addressHint}</p>{identity.data ? <AddressBlock address={identity.data.address} language={language} /> : identity.isLoading ? <Spinner /> : null}{command && <><p className="text-xs text-muted-foreground">{t.trust}</p><AddressBlock address={command} language={language} /></>}</div>
    <p className="text-xs leading-5 text-muted-foreground">{t.onlyShell}</p>
    <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (validAddress(address)) connect.mutate() }}>
      <div className="space-y-1"><label className="text-xs text-muted-foreground" htmlFor="exe-address">{t.addressLabel}</label><Input id="exe-address" className="w-full font-mono sm:w-96" maxLength={64} placeholder={t.addressPlaceholder} value={address} onChange={(event) => setAddress(event.target.value)} /></div>
      <div className="space-y-1"><label className="text-xs text-muted-foreground" htmlFor="exe-label">{t.name}</label><Input id="exe-label" className="w-40" maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} /></div>
      <Button disabled={!validAddress(address) || connect.isPending}>{connect.isPending && <Spinner />}{t.connect}</Button>
    </form>
    {address.trim().length > 0 && !validAddress(address) && <p className="text-xs text-muted-foreground">{t.invalid}</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert>}
    {identity.error && <div className="space-y-2"><Alert variant="destructive"><AlertDescription>{identity.error instanceof Error ? identity.error.message : String(identity.error)}</AlertDescription></Alert><Button variant="outline" onClick={() => void identity.refetch()}>{t.retry}</Button></div>}
    {identity.data && devices.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
    {devices.length > 0 && <ul className="divide-y rounded-lg border">
      {devices.map((device) => <li key={device.worker_id} className="flex flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-2"><KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" /><p className="min-w-0 flex-1 truncate font-medium">{device.label}</p><span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden className={`size-1.5 rounded-full ${device.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />{device.status === "online" ? t.online : t.offline}</span><Button size="sm" variant="ghost" className="text-muted-foreground" disabled={remove.isPending} onClick={() => { if (window.confirm(t.removeConfirm)) remove.mutate(device.worker_id) }}>{t.remove}</Button></div>
        <code className="break-all pl-5 text-xs text-muted-foreground">{device.address}</code>
        <p className="pl-5 text-xs text-muted-foreground">{t.lastSeen}: {device.last_seen_at ? formattedTime(language, device.last_seen_at) : t.never}</p>
      </li>)}
    </ul>}
  </CardContent></Card>
}
