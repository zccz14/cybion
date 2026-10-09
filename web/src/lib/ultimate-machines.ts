export type Machine = {
  id: string
  name: string
  worker_id: string
  worker_label: string | null
  command: string
  intent: string | null
  interval_seconds: number
  thread_id: string
  thread_title: string | null
  enabled: boolean
  last_run_at: number | null
  last_exit: number | null
  created_at: number
}

export type MachineStatus = "ok" | "failed" | "waiting" | "paused"

export type MachineDraft = {
  name: string
  workerId: string
  command: string
  intent: string
  interval: string
}

export const MIN_INTERVAL_SECONDS = 10
export const MAX_INTERVAL_SECONDS = 2592000

export function machineStatus(machine: Machine): MachineStatus {
  if (!machine.enabled) return "paused"
  if (machine.last_run_at == null) return "waiting"
  return machine.last_exit === 0 ? "ok" : "failed"
}

export function machineDraftValid(draft: MachineDraft) {
  const seconds = Number(draft.interval)
  return (
    draft.name.trim().length > 0 &&
    draft.workerId.length > 0 &&
    draft.command.trim().length > 0 &&
    Number.isFinite(seconds) &&
    seconds >= MIN_INTERVAL_SECONDS &&
    seconds <= MAX_INTERVAL_SECONDS
  )
}

// The server treats a missing intent as "keep" and an empty string as "clear",
// so the trimmed draft value is always sent as-is.
export function machinePayload(draft: MachineDraft) {
  return {
    name: draft.name.trim(),
    worker_id: draft.workerId,
    command: draft.command,
    intent: draft.intent.trim(),
    interval_seconds: Number(draft.interval),
  }
}

export function formatInterval(language: "en" | "zh", seconds: number) {
  const units: Array<[number, string, string]> = [
    [86400, "天", "d"],
    [3600, "小时", "h"],
    [60, "分钟", "min"],
    [1, "秒", "s"],
  ]
  for (const [size, zh, en] of units) {
    if (seconds >= size && seconds % size === 0) {
      const value = seconds / size
      return language === "zh" ? `${value} ${zh}` : `${value} ${en}`
    }
  }
  return language === "zh" ? `${seconds} 秒` : `${seconds} s`
}
