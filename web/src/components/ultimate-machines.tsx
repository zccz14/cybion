import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { PlayIcon, PlusIcon, RefreshCwIcon } from "lucide-react"

import { formattedTime } from "@/lib/time"
import { formatInterval, machineStatus, type Machine, type MachineStatus } from "@/lib/ultimate-machines"
import { ownedDevice, type Device } from "@/lib/worker-onboarding"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

const copy = {
  en: {
    newMachine: "New machine",
    newMachineHint: "The machine runs the command on the Worker every interval. A failing run asks its bound Thread to repair it.",
    name: "Name",
    namePlaceholder: "e.g. Disk space",
    worker: "Worker",
    workerPlaceholder: "Select a Worker",
    workerHint: "Only Workers you own can run machines.",
    command: "Command",
    commandHint: "Exit code 0 means healthy; any other result asks the Thread to fix it.",
    interval: "Interval (seconds)",
    intervalHint: "10–2592000 seconds. The first check runs right after creation.",
    create: "Create",
    creating: "Creating…",
    cancel: "Cancel",
    empty: "No machines yet.",
    emptyHint: "Create one to turn a failing check into a repair request in a bound Thread.",
    columnStatus: "Status",
    columnName: "Name",
    columnWorker: "Worker",
    columnCommand: "Command",
    columnInterval: "Interval",
    columnLastRun: "Last run",
    columnResult: "Result",
    columnThread: "Repair Thread",
    columnActions: "Actions",
    statusOk: "OK",
    statusFailed: "Failed",
    statusWaiting: "Waiting",
    statusPaused: "Paused",
    repairThread: "Thread",
    runNow: "Run now",
    enable: "Enabled",
    refresh: "Refresh",
    loadError: "Could not load machines",
    retry: "Retry",
  },
  zh: {
    newMachine: "新建机器",
    newMachineHint: "机器按间隔在 Worker 上执行命令；失败时会请绑定的 Thread 修复。",
    name: "名称",
    namePlaceholder: "例如：磁盘空间",
    worker: "Worker",
    workerPlaceholder: "选择 Worker",
    workerHint: "只能绑定自己的 Worker。",
    command: "命令",
    commandHint: "返回 0 表示正常；其他结果会请 Thread 修复。",
    interval: "间隔（秒）",
    intervalHint: "10–2592000 秒；创建后立即执行第一次检查。",
    create: "创建",
    creating: "创建中…",
    cancel: "取消",
    empty: "还没有终极机器。",
    emptyHint: "创建一台，让失败的检查变成绑定 Thread 里的修复请求。",
    columnStatus: "状态",
    columnName: "名称",
    columnWorker: "Worker",
    columnCommand: "命令",
    columnInterval: "间隔",
    columnLastRun: "最近运行",
    columnResult: "最近结果",
    columnThread: "修复 Thread",
    columnActions: "操作",
    statusOk: "正常",
    statusFailed: "失败",
    statusWaiting: "等待",
    statusPaused: "已暂停",
    repairThread: "Thread",
    runNow: "立即运行",
    enable: "启用",
    refresh: "刷新",
    loadError: "无法加载终极机器",
    retry: "重试",
  },
}

const statusDot: Record<MachineStatus, string> = {
  ok: "bg-emerald-500",
  failed: "bg-red-500",
  waiting: "bg-amber-500",
  paused: "bg-muted-foreground/40",
}

const MIN_INTERVAL_SECONDS = 10
const MAX_INTERVAL_SECONDS = 2592000

type Props = { language: "zh" | "en"; sessionId: string | null | undefined; request: <T>(path: string, init?: RequestInit) => Promise<T> }

export function UltimateMachines(props: Props) { return <UltimateMachinesSession key={props.sessionId} {...props} /> }

function UltimateMachinesSession({ language, sessionId, request }: Props) {
  const t = (key: keyof typeof copy.en) => copy[language][key]
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [workerId, setWorkerId] = useState("")
  const [command, setCommand] = useState("")
  const [intervalValue, setIntervalValue] = useState("600")

  const machines = useQuery({
    queryKey: ["machines", sessionId],
    queryFn: ({ signal }) => request<Machine[]>("/api/machines", { signal }),
    refetchInterval: 5000,
    retry: false,
  })
  const workers = useQuery({
    queryKey: ["workers", sessionId],
    queryFn: ({ signal }) => request<Device[]>("/api/workers", { signal }),
    refetchInterval: 5000,
    retry: false,
  })
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["machines"] })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      request<Machine>(`/api/machines/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: invalidate,
  })
  const run = useMutation({
    mutationFn: (id: string) => request(`/api/machines/${encodeURIComponent(id)}/run`, { method: "POST" }),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: (input: { name: string; worker_id: string; command: string; interval_seconds: number }) =>
      request<Machine>("/api/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      invalidate()
      setOpen(false)
      setName("")
      setWorkerId("")
      setCommand("")
      setIntervalValue("600")
    },
  })

  const intervalSeconds = Number(intervalValue)
  const intervalValid = Number.isFinite(intervalSeconds) && intervalSeconds >= MIN_INTERVAL_SECONDS && intervalSeconds <= MAX_INTERVAL_SECONDS
  const canSubmit = name.trim().length > 0 && workerId.length > 0 && command.trim().length > 0 && intervalValid && !create.isPending
  const ownedWorkers = (workers.data ?? []).filter(ownedDevice)
  const mutationError = (toggle.error ?? run.error) as Error | null
  const items = machines.data ?? []

  return (
    <>
      {machines.error && <RequestError label={t("loadError")} error={machines.error as Error} onRetry={() => void machines.refetch()} retry={t("retry")} />}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>{t("newMachine")}</CardTitle>
            <CardDescription>{t("newMachineHint")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void machines.refetch()}>
              <RefreshCwIcon />{t("refresh")}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><PlusIcon />{t("newMachine")}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("newMachine")}</DialogTitle>
                  <DialogDescription>{t("newMachineHint")}</DialogDescription>
                </DialogHeader>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="machine-name">{t("name")}</FieldLabel>
                    <FieldContent>
                      <Input id="machine-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("namePlaceholder")} />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel>{t("worker")}</FieldLabel>
                    <FieldContent>
                      <Select value={workerId} onValueChange={setWorkerId}>
                        <SelectTrigger><SelectValue placeholder={t("workerPlaceholder")} /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {ownedWorkers.map((device) => <SelectItem key={device.id} value={device.id}>{device.label}</SelectItem>)}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FieldContent>
                    <FieldDescription>{t("workerHint")}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="machine-command">{t("command")}</FieldLabel>
                    <FieldContent>
                      <Textarea id="machine-command" rows={3} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="curl -fsS http://127.0.0.1:8080/health" />
                    </FieldContent>
                    <FieldDescription>{t("commandHint")}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="machine-interval">{t("interval")}</FieldLabel>
                    <FieldContent>
                      <Input id="machine-interval" type="number" min={MIN_INTERVAL_SECONDS} max={MAX_INTERVAL_SECONDS} value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)} />
                    </FieldContent>
                    <FieldDescription>{t("intervalHint")}</FieldDescription>
                  </Field>
                </FieldGroup>
                {create.error && <Alert variant="destructive"><AlertDescription>{(create.error as Error).message}</AlertDescription></Alert>}
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>{t("cancel")}</Button>
                  <Button disabled={!canSubmit} onClick={() => create.mutate({ name: name.trim(), worker_id: workerId, command, interval_seconds: intervalSeconds })}>
                    {create.isPending ? t("creating") : t("create")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mutationError && <Alert variant="destructive"><AlertDescription>{mutationError.message}</AlertDescription></Alert>}
          {machines.isLoading && <div className="flex justify-center p-6"><Spinner /></div>}
          {!machines.isLoading && items.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <p>{t("empty")}</p>
              <p className="mt-1">{t("emptyHint")}</p>
            </div>
          )}
          {items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columnStatus")}</TableHead>
                  <TableHead>{t("columnName")}</TableHead>
                  <TableHead>{t("columnWorker")}</TableHead>
                  <TableHead>{t("columnCommand")}</TableHead>
                  <TableHead>{t("columnInterval")}</TableHead>
                  <TableHead>{t("columnLastRun")}</TableHead>
                  <TableHead>{t("columnResult")}</TableHead>
                  <TableHead>{t("columnThread")}</TableHead>
                  <TableHead className="text-right">{t("columnActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((machine) => {
                  const status = machineStatus(machine)
                  return (
                    <TableRow key={machine.id}>
                      <TableCell>
                        <span className="flex items-center gap-2 text-xs">
                          <span className={`size-2 rounded-full ${statusDot[status]}`} aria-hidden="true" />
                          <span>{t(`status${status.charAt(0).toUpperCase()}${status.slice(1)}` as keyof typeof copy.en)}</span>
                        </span>
                      </TableCell>
                      <TableCell className="font-medium">{machine.name}</TableCell>
                      <TableCell>{machine.worker_label ?? machine.worker_id.slice(0, 8)}</TableCell>
                      <TableCell>
                        <code className="block max-w-[22rem] truncate font-mono text-xs" title={machine.command}>{machine.command}</code>
                      </TableCell>
                      <TableCell className="text-xs">{formatInterval(language, machine.interval_seconds)}</TableCell>
                      <TableCell className="text-xs">{formattedTime(language, machine.last_run_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{machine.last_exit == null ? "—" : String(machine.last_exit)}</TableCell>
                      <TableCell className="text-xs">
                        <Link className="underline decoration-border underline-offset-4 hover:decoration-foreground" to={`/threads/${machine.thread_id}`}>
                          {machine.thread_title ?? t("repairThread")}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2">
                          <Switch checked={machine.enabled} disabled={toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ id: machine.id, enabled })} aria-label={t("enable")} />
                          <Button variant="outline" size="sm" disabled={run.isPending} onClick={() => run.mutate(machine.id)}>
                            <PlayIcon />{t("runNow")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}

function RequestError({ error, onRetry, retry }: { error: Error; onRetry: () => void; label: string; retry: string }) {
  return <Alert variant="destructive"><AlertDescription>{error.message}<Button variant="outline" size="sm" onClick={onRetry}>{retry}</Button></AlertDescription></Alert>
}
