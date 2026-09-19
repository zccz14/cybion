import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useSearchParams } from "react-router-dom"
import { CheckIcon, CopyIcon, DownloadIcon, MonitorIcon, PlusIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formattedTime } from "@/lib/time"
import { checkReady, deviceStatus, downloadUrl, installCommand, normalizeCode, runCommand, validCode, type Check, type Device, type Pairing, type Release } from "@/lib/worker-onboarding"

type Language = "zh" | "en"
type Request = <T>(path: string, init?: RequestInit) => Promise<T>
const copy = {
  zh: {
    title: "连接设备", description: "让 Cybion 在你的电脑或服务器上执行任务。从安装到验证，一步步完成连接。",
    add: "连接新设备", devices: "我的设备", empty: "还没有连接的设备。", local: "当前电脑", remote: "另一台电脑或服务器",
    target: "1. 安装并启动", targetHint: "选择目标设备的系统和处理器。浏览器无法可靠识别目标设备架构，请确认后下载。",
    platform: "目标设备平台", selectPlatform: "选择系统与处理器", download: "下载 Worker", recommended: "推荐版本", notes: "发布说明",
    localHint: "在这台电脑上下载并解压，然后在解压后的文件夹中打开终端。", remoteHint: "以下命令必须在目标电脑或服务器运行，不是在当前浏览器所在设备运行。",
    macHint: "Mac：在“关于本机”中查看芯片。Apple M 系列选择 Apple Silicon，Intel 选择 Intel。", windowsHint: "Windows：解压 ZIP 后在文件夹中打开 PowerShell。",
    startup: "执行以下命令。首次运行会打开授权网页；没有浏览器时，在任意设备打开终端显示的地址。", remoteCommand: "下载、校验并启动（在空目录中运行）",
    security: "连接后，Cybion 可在目标设备的运行账户权限范围内执行命令，并使用可用的浏览器和桌面操作能力。不是每条命令都会再次弹窗确认。",
    background: "后台运行不等于开机自启。此版本不自动安装系统服务；重启后需再次启动 Worker。已有配置会继续使用，不会覆盖或自动创建新设备。升级 v0.1.3 或更早版本时，请先停止旧 Worker 进程；旧版没有进程锁。",
    approve: "2. 确认授权", code: "设备配对码", lookup: "查看设备", codeHint: "输入目标设备终端显示的 12 位配对码，或使用 Worker 自动打开的网页。不要批准其他人发送的配对码。",
    confirm: "确认连接这台设备", cancel: "拒绝配对", name: "设备名称", verify: "核对设备信息和配对码一致后再授权。以下设备信息由 Worker 自报，并非身份认证证明。",
    expires: "有效期至", expired: "配对已过期。请在目标设备重新运行 Worker，获取新配对码。", cancelled: "已拒绝这次配对。需要连接时，请重新运行 Worker。",
    deviceMissing: "设备列表中尚未找到这台设备。请刷新列表；如果已移除设备，请在目标设备重新配对。",
    approved: "已授权，等待设备连接", waitingHint: "尚未收到这台设备的连接。请保持目标设备上的 Worker 运行；不要重复创建配对。",
    check: "3. 检查并开始使用", checkButton: "运行连接检查", checking: "正在验证任务下发、命令执行和结果回传…", timedOut: "检查超时。可能是 Worker 未运行或任务通道不可用；请运行 doctor 并查看日志，然后重试。",
    ready: "命令执行已验证，可开始使用", notReady: "尚未通过执行检查", start: "开始使用这台设备", checkHint: "检查只运行固定的 echo 测试，不读取你的文件，不点击或输入桌面内容。",
    shell: "命令执行", browser: "浏览器控制", desktop: "桌面操作", not_checked: "未检查", missing_dependency: "缺少依赖", unsupported: "不适用", failed: "检查失败", capabilityReady: "可用",
    shell_ok: "固定测试命令执行成功。", shell_failed: "无法执行测试命令，请运行 doctor 查看本机诊断。",
    browser_installed: "已发现浏览器，但未启动或测试；这不代表浏览器控制已经可用。", browser_missing: "请安装 Chrome、Chromium 或 Edge，然后重新检查。",
    no_display: "未检测到 X11 显示会话，此环境不提供桌面操作。", desktop_permissions: "尚未验证系统权限。macOS 需在系统设置中检查辅助功能与自动化授权；Linux 需有受支持的桌面会话及 xdotool。",
    help: "故障排查与启动说明", helpBody: "在 Worker 所在文件夹运行以下命令。doctor 检查控制器认证和本机依赖；网页检查验证真实任务通道。诊断不输出 access token。",
    logs: "日志位于配置目录的 worker.log。默认配置目录：macOS/Linux 为 ~/.cybion；Windows 为 %USERPROFILE%\\.cybion。",
    restore: "中断后重新运行相同命令即可继续。过期或拒绝后会生成新配对码。已有配置失效时，先在网页移除旧设备，停止旧进程，再将 worker.toml 移到安全位置后重新启动。不要分享配置文件。",
    waiting: "等待首次连接", online: "在线", offline: "离线", lastSeen: "最后连接", created: "创建于", rename: "重命名", save: "保存", remove: "移除", removeConfirm: "移除此设备会撤销连接凭证。正在本机执行的任务不会因此自动终止。确认移除？",
    retry: "重试", copied: "已复制", copy: "复制", copyFailed: "复制失败，请手动选择并复制内容。", close: "关闭引导", remaining: "你可以安全刷新页面，授权进度由服务端保存。", checkTime: "检查时间", codeMismatch: "请填写完整配对码。",
    legacy: "高级：手动配置", legacyHint: "仅用于已知配置流程。配置包含长期凭证，只显示一次，不保存到浏览器缓存。普通连接请使用上面的短期配对。",
    legacyCreate: "生成手动配置", configDownload: "下载 worker.toml", configSaved: "保存到目标设备配置目录后运行 Worker。页面关闭或刷新后无法重新显示凭证；丢失时移除该设备并重新配对。",
  },
  en: {
    title: "Connect a device", description: "Run Cybion tasks on your computer or server. Follow installation, authorization and verification in one place.",
    add: "Connect a new device", devices: "My devices", empty: "No devices connected yet.", local: "This computer", remote: "Another computer or server",
    target: "1. Install and start", targetHint: "Choose the target device's OS and processor. A browser cannot reliably detect its architecture; verify before downloading.",
    platform: "Target platform", selectPlatform: "Choose OS and processor", download: "Download Worker", recommended: "Recommended version", notes: "Release notes",
    localHint: "Download and extract on this computer, then open a terminal in the extracted folder.", remoteHint: "Run these commands on the target computer or server, not on the device hosting this browser.",
    macHint: "Mac: check About This Mac. Apple M-series uses Apple Silicon; Intel uses Intel.", windowsHint: "Windows: extract the ZIP and open PowerShell in the extracted folder.",
    startup: "Run this command. First launch opens browser authorization; on a headless device, open the printed address on any device.", remoteCommand: "Download, verify and start (run in an empty directory)",
    security: "Once connected, Cybion can execute commands with the Worker's OS account permissions and use available browser and desktop controls. This is not a per-command approval prompt.",
    background: "Background mode is not automatic startup. This version does not install a system service; restart the Worker after reboot. Existing configuration is reused, never overwritten or silently paired again. Before upgrading v0.1.3 or earlier, stop the old Worker process; older versions do not have a process lock.",
    approve: "2. Confirm authorization", code: "Device pairing code", lookup: "Review device", codeHint: "Enter the 12-character code printed on the target device, or use the page opened by Worker. Do not approve codes sent by others.",
    confirm: "Confirm connection to this device", cancel: "Reject pairing", name: "Device name", verify: "Check that the device and code match before authorizing. Device details are self-reported, not proof of identity.",
    expires: "Expires at", expired: "Pairing expired. Run Worker on the target device again to get a new code.", cancelled: "Pairing rejected. Run Worker again when you want to connect.",
    deviceMissing: "Device not found in the list. Refresh the list; if it was removed, re-pair on the target device.",
    approved: "Authorized; waiting for device", waitingHint: "No connection received from this device yet. Keep Worker running on the target device; do not create another pairing.",
    check: "3. Check and start using", checkButton: "Run connection check", checking: "Checking task delivery, command execution and result upload…", timedOut: "Check timed out. Worker may not be running or the task channel may be unavailable. Run doctor and inspect logs, then retry.",
    ready: "Command execution verified; ready to use", notReady: "Execution not yet verified", start: "Start using this device", checkHint: "Runs only a fixed echo test. Does not read your files or click/type on your desktop.",
    shell: "Command execution", browser: "Browser control", desktop: "Desktop control", not_checked: "Not checked", missing_dependency: "Missing dependency", unsupported: "Not applicable", failed: "Check failed", capabilityReady: "Ready",
    shell_ok: "Fixed test command succeeded.", shell_failed: "Test command failed. Run doctor for local diagnostics.",
    browser_installed: "Browser found but not launched or tested; browser control is not yet verified.", browser_missing: "Install Chrome, Chromium or Edge, then check again.",
    no_display: "No X11 display session detected; desktop control is unavailable in this environment.", desktop_permissions: "OS permissions have not been verified. On macOS, check Accessibility and Automation in System Settings; Linux requires a supported desktop session and xdotool.",
    help: "Troubleshooting and startup", helpBody: "Run these commands in the Worker folder. Doctor checks authentication and local dependencies; the web check validates the real task channel. Diagnostics do not print the access token.",
    logs: "Logs: worker.log in the config directory. Default directory: ~/.cybion on macOS/Linux; %USERPROFILE%\\.cybion on Windows.",
    restore: "After interruption, run the same command to resume. Expired or rejected requests get a new code. For invalid existing credentials, remove the old device here, stop the old process, move worker.toml to a safe location, then restart. Do not share the config file.",
    waiting: "Waiting for first connection", online: "Online", offline: "Offline", lastSeen: "Last connected", created: "Created", rename: "Rename", save: "Save", remove: "Remove", removeConfirm: "Removing this device revokes its credentials. It does not terminate commands already running locally. Remove device?",
    retry: "Retry", copied: "Copied", copy: "Copy", copyFailed: "Copy failed. Select and copy the text manually.", close: "Close guide", remaining: "You can safely refresh this page. Authorization progress is stored on the server.", checkTime: "Checked at", codeMismatch: "Enter the complete pairing code.",
    legacy: "Advanced: manual configuration", legacyHint: "For existing manual workflows only. Configuration contains a long-lived credential, shown once and never persisted in browser storage. Prefer short-lived pairing above.",
    legacyCreate: "Generate manual configuration", configDownload: "Download worker.toml", configSaved: "Save in the target device's config directory and run Worker. Refreshing loses this credential; remove the device and pair again if it is lost.",
  },
} satisfies Record<Language, Record<string,string>>

function ErrorNotice({ error }: { error: unknown }) { return error ? <Alert variant="destructive"><AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription></Alert> : null }

export function CopyBlock({ text, language }: { text: string; language: Language }) {
  const t = copy[language]
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  useEffect(() => setStatus("idle"), [text])
  return <div className="space-y-2"><div className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3"><pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6">{text}</pre><Button size="icon-sm" variant="outline" aria-label={t.copy} onClick={async () => { try { await navigator.clipboard.writeText(text); setStatus("copied") } catch { setStatus("failed") } }}>{status === "copied" ? <CheckIcon /> : <CopyIcon />}</Button></div><p role="status" className="text-xs text-muted-foreground">{status === "copied" ? t.copied : status === "failed" ? t.copyFailed : ""}</p></div>
}

function ConnectionCheck({ device, language, request, sessionId, automatic = false }: { device: Device; language: Language; request: Request; sessionId: string | null | undefined; automatic?: boolean }) {
  const t = copy[language]
  const client = useQueryClient()
  const key = ["worker-check", sessionId, device.id]
  const check = useQuery({ queryKey: key, queryFn: () => request<Check | null>(`/api/workers/${device.id}/check`), refetchInterval: (q) => q.state.data && ["queued", "delivered"].includes(q.state.data.status) ? 2000 : false })
  const run = useMutation({ mutationFn: () => request<Check>(`/api/workers/${device.id}/check`, { method: "POST" }), onSuccess: (value) => client.setQueryData(key, value) })
  useEffect(() => { if (automatic && device.status === "online" && check.isSuccess && check.data === null && run.status === "idle") run.mutate() }, [automatic, device.status, check.isSuccess, check.data, run])
  const busy = run.isPending || Boolean(check.data && ["queued", "delivered"].includes(check.data.status))
  const ready = checkReady(check.data, device)
  const result = check.data?.result
  const prompt = language === "zh" ? `请在 ${device.label}（worker_id: ${device.id}）上运行一个只输出系统名称的命令，不修改文件。` : `On ${device.label} (worker_id: ${device.id}), run a read-only command that prints the operating system name. Do not modify files.`
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3"><Badge variant={ready ? "secondary" : "outline"}>{ready ? t.ready : t.notReady}</Badge><Button variant="outline" size="sm" disabled={busy || device.status !== "online"} onClick={() => run.mutate()}>{busy ? <Spinner /> : <RefreshCwIcon />}{t.checkButton}</Button></div>
    <p className="text-xs text-muted-foreground">{t.checkHint}</p>
    {busy && <p role="status" className="text-sm">{t.checking}</p>}
    {check.data?.status === "timed_out" && <Alert><AlertDescription>{t.timedOut}</AlertDescription></Alert>}
    <ErrorNotice error={check.error || run.error} />
    {result && <div className="grid gap-3 md:grid-cols-3">{(["shell", "browser", "desktop"] as const).map((kind) => {
      const capability = result[kind]
      const status = capability?.status ?? "not_checked"
      return <div className="rounded-lg border p-3" key={kind}><div className="flex items-center justify-between gap-2"><h4 className="text-sm font-medium">{t[kind]}</h4><Badge variant="outline">{status === "ready" ? t.capabilityReady : t[status]}</Badge></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{capability && (t[capability.detail as keyof typeof t] ?? capability.detail)}</p></div>
    })}</div>}
    {check.data?.completed_at && <p className="text-xs text-muted-foreground">{t.checkTime}: {formattedTime(language, check.data.completed_at)}</p>}
    {ready && <Button asChild><Link to="/threads/new" state={{ initialInput: prompt }}>{t.start}</Link></Button>}
  </div>
}

export function WorkerConnections({ language, request, sessionId }: { language: Language; request: Request; sessionId: string | null | undefined }) {
  const t = copy[language]
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const routeCode = normalizeCode(params.get("code") ?? "")
  const [show, setShow] = useState(Boolean(routeCode))
  const [target, setTarget] = useState("local")
  const [platform, setPlatform] = useState("")
  const [inputCode, setInputCode] = useState(routeCode)
  const [name, setName] = useState("")
  const [confirmed, setConfirmed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const workers = useQuery({ queryKey: ["workers", sessionId], queryFn: () => request<Device[]>("/api/workers"), refetchInterval: 3000 })
  const release = useQuery({ queryKey: ["worker-release"], queryFn: () => request<Release>("/api/worker-release"), staleTime: 60000 })
  const pairing = useQuery({ queryKey: ["worker-pairing", sessionId, routeCode], queryFn: () => request<Pairing>(`/api/worker-pairings/${routeCode}`), enabled: validCode(routeCode), retry: false, refetchInterval: (q) => q.state.data && ["pending", "approving"].includes(q.state.data.status) ? 5000 : false })
  useEffect(() => { setInputCode(routeCode); setConfirmed(false); setName(""); if (routeCode) setShow(true) }, [routeCode])
  const approval = useMutation({ mutationFn: () => request<Pairing>(`/api/worker-pairings/${routeCode}`, { method: "POST", body: JSON.stringify({ label: name.trim() || pairing.data?.hostname }) }), onSuccess: (value) => { client.setQueryData(["worker-pairing", sessionId, value.user_code], value); void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const cancel = useMutation({ mutationFn: () => request(`/api/worker-pairings/${routeCode}`, { method: "DELETE" }), onSuccess: () => { void pairing.refetch() } })
  const rename = useMutation({ mutationFn: ({ id, label }: { id: string; label: string }) => request(`/api/workers/${id}`, { method: "PATCH", body: JSON.stringify({ label }) }), onSuccess: () => { setEditing(null); void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const remove = useMutation({ mutationFn: (id: string) => request(`/api/workers/${id}`, { method: "DELETE" }), onSuccess: () => { void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const pairedDevice = workers.data?.find((device) => device.id === pairing.data?.worker_id)
  const wizard = show || workers.data?.length === 0
  const currentStep = pairing.data?.status === "approved" ? 3 : routeCode ? 2 : 1
  const lookup = () => { const code = normalizeCode(inputCode); if (validCode(code)) { approval.reset(); cancel.reset(); setParams({ code }) } }
  const prefix = platform.startsWith("windows") ? ".\\cybion-worker.exe" : "./cybion-worker"
  return <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold">{t.title}</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t.description}</p></div><Button onClick={() => { setShow(true); setParams({}); approval.reset(); cancel.reset() }}><PlusIcon />{t.add}</Button></div>
    <ErrorNotice error={workers.error || release.error} />
    {wizard && <>
      <ol className="grid grid-cols-3 gap-2 text-xs sm:text-sm" aria-label={t.title}>{[t.target, t.approve, t.check].map((step, i) => <li key={step} aria-current={i + 1 === currentStep ? "step" : undefined} className={`rounded-lg border p-3 ${i + 1 === currentStep ? "border-primary bg-primary/5 font-medium" : "text-muted-foreground"}`}>{step}</li>)}</ol>
      <Card><CardHeader><CardTitle>{t.target}</CardTitle><CardDescription>{t.targetHint}</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="flex flex-wrap gap-4">{["local", "remote"].map((value) => <label key={value} className="flex items-center gap-2 text-sm"><input type="radio" name="worker-target" checked={target === value} onChange={() => { setTarget(value); setPlatform("") }} />{t[value as "local" | "remote"]}</label>)}</div>
        <p className="text-sm">{target === "local" ? t.localHint : t.remoteHint}</p>
        <div className="flex flex-wrap items-center gap-3"><Select value={platform} onValueChange={setPlatform}><SelectTrigger className="w-full sm:w-72" aria-label={t.platform}><SelectValue placeholder={t.selectPlatform} /></SelectTrigger><SelectContent>{release.data?.platforms.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent></Select>{release.data && <Badge variant="outline">{t.recommended} {release.data.version}</Badge>}</div>
        {platform && release.data && <div className="space-y-3"><p className="text-xs text-muted-foreground">{platform.startsWith("macos") ? t.macHint : platform.startsWith("windows") ? t.windowsHint : t.remoteHint}</p><div className="flex flex-wrap items-center gap-4"><Button asChild variant="outline"><a href={downloadUrl(release.data, platform)}><DownloadIcon />{t.download}</a></Button><a className="text-xs underline" href={release.data.release_url} target="_blank" rel="noreferrer">{t.notes}</a></div><p className="text-sm">{t.startup}</p><CopyBlock language={language} text={runCommand(platform)} /><details open={target === "remote"}><summary className="cursor-pointer text-sm">{t.remoteCommand}</summary><div className="mt-3"><CopyBlock language={language} text={installCommand(release.data, platform)} /></div></details></div>}
        <p className="text-xs leading-5 text-muted-foreground">{t.background}</p>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>{t.approve}</CardTitle><CardDescription>{t.codeHint}</CardDescription></CardHeader><CardContent className="space-y-4">
        <form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); lookup() }}><Input className="max-w-xs font-mono uppercase" aria-label={t.code} placeholder="ABCD-1234-EF56" value={inputCode} maxLength={20} onChange={(e) => setInputCode(e.target.value)} /><Button disabled={!validCode(inputCode) || pairing.isFetching}>{pairing.isFetching && <Spinner />}{t.lookup}</Button></form>
        <ErrorNotice error={pairing.error || approval.error || cancel.error} />
        {pairing.data && <div className="space-y-4" aria-live="polite"><div className="rounded-lg border p-4"><p className="font-medium">{pairing.data.hostname}</p><p className="mt-1 text-sm text-muted-foreground">{pairing.data.platform} · Worker {pairing.data.version}</p><p className="my-3 font-mono text-xl tracking-wider">{pairing.data.user_code}</p><p className="text-xs text-muted-foreground">{t.expires}: {formattedTime(language, pairing.data.expires_at)}</p></div>
          {["pending", "approving"].includes(pairing.data.status) && <><Alert><ShieldCheckIcon /><AlertDescription>{t.security}</AlertDescription></Alert><Input aria-label={t.name} maxLength={80} placeholder={pairing.data.hostname} value={name} onChange={(e) => setName(e.target.value)} /><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{t.verify}</label><div className="flex flex-wrap gap-3"><Button disabled={!confirmed || approval.isPending || cancel.isPending} onClick={() => approval.mutate()}>{approval.isPending && <Spinner />}{t.confirm}</Button><Button variant="outline" disabled={approval.isPending || cancel.isPending || pairing.data.status === "approving"} onClick={() => cancel.mutate()}>{t.cancel}</Button></div></>}
          {pairing.data.status === "expired" && <Alert><AlertDescription>{t.expired}</AlertDescription></Alert>}
          {pairing.data.status === "cancelled" && <Alert><AlertDescription>{t.cancelled}</AlertDescription></Alert>}
          {pairing.data.status === "approved" && <p className="text-sm">{pairedDevice?.status === "online" ? t.online : t.approved}</p>}
          <p className="text-xs text-muted-foreground">{t.remaining}</p>
        </div>}
      </CardContent></Card>
      {pairing.data?.status === "approved" && <Card><CardHeader><CardTitle>{t.check}</CardTitle></CardHeader><CardContent>{pairedDevice ? <ConnectionCheck automatic device={pairedDevice} language={language} request={request} sessionId={sessionId} /> : <div className="space-y-3"><p className="text-sm">{t.deviceMissing}</p><Button variant="outline" onClick={() => void workers.refetch()}>{t.retry}</Button></div>}{pairedDevice && pairedDevice.last_seen_at == null && <p className="mt-3 text-sm text-muted-foreground">{t.waitingHint}</p>}</CardContent></Card>}
      <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">{t.help}</summary><div className="mt-4 space-y-3"><p className="text-sm">{t.helpBody}</p><CopyBlock language={language} text={`${prefix} status\n${prefix} doctor\n${prefix} config-path`} /><p className="text-xs text-muted-foreground">{t.logs}</p><p className="text-xs leading-6 text-muted-foreground">{t.restore}</p></div></details>
      <ManualPairing language={language} request={request} />
      {workers.data && workers.data.length > 0 && <Button className="self-start" variant="ghost" onClick={() => { setShow(false); setParams({}) }}>{t.close}</Button>}
    </>}
    <Card><CardHeader><CardTitle>{t.devices}</CardTitle></CardHeader><CardContent className="space-y-3">
      <ErrorNotice error={rename.error || remove.error} />
      {workers.isLoading && <Spinner />}{workers.data?.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      {workers.data?.map((device) => <div key={device.id} className="rounded-xl border p-4"><div className="flex flex-wrap items-center gap-3"><MonitorIcon className="size-4" /><div className="min-w-0 flex-1">{editing === device.id ? <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (editName.trim()) rename.mutate({ id: device.id, label: editName.trim() }) }}><Input aria-label={t.name} value={editName} maxLength={80} onChange={(e) => setEditName(e.target.value)} /><Button size="sm" disabled={rename.isPending || !editName.trim()}>{t.save}</Button></form> : <p className="font-medium">{device.label}</p>}<p className="mt-1 text-xs text-muted-foreground">{device.last_seen_at ? t.lastSeen : t.created}: {formattedTime(language, device.last_seen_at ?? device.created_at)}</p></div><Badge variant="outline">{t[deviceStatus(device)]}</Badge><Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === device.id ? null : device.id)}>{t.checkButton}</Button><Button size="sm" variant="ghost" onClick={() => { setEditing(device.id); setEditName(device.label) }}>{t.rename}</Button><Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { if (window.confirm(t.removeConfirm)) remove.mutate(device.id) }}>{t.remove}</Button></div>{expanded === device.id && <div className="mt-4 border-t pt-4"><ConnectionCheck device={device} language={language} request={request} sessionId={sessionId} /><p className="mt-4 text-xs text-muted-foreground">{t.logs}</p></div>}</div>)}
    </CardContent></Card>
  </main>
}

function ManualPairing({ language, request }: { language: Language; request: Request }) {
  const t = copy[language]
  const client = useQueryClient()
  const [name, setName] = useState("")
  const pairing = useMutation({ mutationFn: () => request<Record<string, string>>("/api/workers", { method: "POST", body: JSON.stringify({ label: name.trim() }) }), onSuccess: () => { void client.invalidateQueries({ queryKey: ["workers"] }) } })
  const config = pairing.data ? ["controller_url", "user_id", "machine_id", "access_token"].map((key) => `${key} = ${JSON.stringify(pairing.data![key])}`).join("\n") + "\n" : ""
  return <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm">{t.legacy}</summary><div className="mt-4 space-y-3"><p className="text-xs leading-5 text-muted-foreground">{t.legacyHint}</p><form className="flex flex-wrap gap-3" onSubmit={(e) => { e.preventDefault(); pairing.mutate() }}><Input className="max-w-xs" aria-label={t.name} placeholder={t.name} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /><Button variant="outline" disabled={!name.trim() || pairing.isPending || pairing.isSuccess}>{t.legacyCreate}</Button></form><ErrorNotice error={pairing.error} />{config && <><Button variant="outline" onClick={() => { const url = URL.createObjectURL(new Blob([config], { type: "application/toml" })); const link = document.createElement("a"); link.href = url; link.download = "worker.toml"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }}>{t.configDownload}</Button><CopyBlock text={config} language={language} /><p className="text-xs text-muted-foreground">{t.configSaved}</p><p className="text-xs text-muted-foreground">{t.logs}</p></>}</div></details>
}
