export type Machine = {
  id: string
  name: string
  worker_id: string
  worker_label: string | null
  command: string
  interval_seconds: number
  thread_id: string
  thread_title: string | null
  enabled: boolean
  last_run_at: number | null
  last_exit: number | null
  created_at: number
}

export type MachineStatus = "ok" | "failed" | "waiting" | "paused"

export function machineStatus(machine: Machine): MachineStatus {
  if (!machine.enabled) return "paused"
  if (machine.last_run_at == null) return "waiting"
  return machine.last_exit === 0 ? "ok" : "failed"
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
