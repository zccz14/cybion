import type { ReactNode } from "react"
import { WrenchIcon } from "lucide-react"
import type { CybionToolFunctionCall } from "@/lib/history-payload"

const copy = {
  en: {
    listContexts: "List contexts", listWorkers: "List Workers", readContext: "Read context", listMachines: "List Ultimate Machines",
    getMachine: "Read Ultimate Machine", updateMachine: "Update Ultimate Machine", createMachine: "Create Ultimate Machine",
    name: "Name", worker: "Worker", interval: "Interval", state: "State", enabled: "Enabled", paused: "Paused", command: "Command", intent: "Intent",
  },
  zh: {
    listContexts: "列出上下文", listWorkers: "列出 Worker", readContext: "读取上下文", listMachines: "列出终极机器",
    getMachine: "读取终极机器", updateMachine: "更新终极机器", createMachine: "创建终极机器",
    name: "名称", worker: "Worker", interval: "间隔", state: "状态", enabled: "启用", paused: "已暂停", command: "命令", intent: "意图",
  },
} as const

const monoBlock = "mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5"

export function CybionToolCall({ language, call, workers, time, children }: {
  language: "en" | "zh"
  call: CybionToolFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  const title = (() => {
    switch (call.tool) {
      case "read_context": return text.readContext
      case "cybion_list_contexts": return text.listContexts
      case "cybion_list_workers": return text.listWorkers
      case "cybion_list_ultimate_machines": return text.listMachines
      case "cybion_get_ultimate_machine": return text.getMachine
      case "cybion_set_ultimate_machine": return call.machineId !== null ? text.updateMachine : text.createMachine
    }
  })()
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <WrenchIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <CybionToolDetail language={language} call={call} workers={workers} />
      {children}
    </div>
  </div>
}

function CybionToolDetail({ language, call, workers }: {
  language: "en" | "zh"
  call: CybionToolFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
}) {
  const text = copy[language]
  switch (call.tool) {
    case "read_context":
      return <pre className={monoBlock}>{call.contextId}</pre>
    case "cybion_get_ultimate_machine":
      return <pre className={monoBlock}>{call.machineId}</pre>
    case "cybion_list_contexts":
    case "cybion_list_workers":
    case "cybion_list_ultimate_machines":
      return null
    case "cybion_set_ultimate_machine": {
      const rows: string[] = []
      const row = (label: string, value: string) => rows.push(`${label}${language === "zh" ? "：" : ": "}${value}`)
      if (call.name !== null) row(text.name, call.name)
      if (call.workerId !== null) row(text.worker, workers?.find((worker) => worker.id === call.workerId)?.label ?? call.workerId)
      if (call.intervalSeconds !== null) row(text.interval, language === "zh" ? `${call.intervalSeconds} 秒` : `${call.intervalSeconds}s`)
      if (call.enabled !== null) row(text.state, call.enabled ? text.enabled : text.paused)
      return <>
        {call.machineId !== null && <pre className={monoBlock}>{call.machineId}</pre>}
        {rows.map((value) => <p key={value} className="mt-1.5 text-xs text-muted-foreground">{value}</p>)}
        {call.command !== null && <>
          <p className="mt-2 text-sm text-muted-foreground">{text.command}</p>
          <pre className={monoBlock}>{call.command}</pre>
        </>}
        {call.intent !== null && <p className="mt-1.5 text-xs text-muted-foreground">{text.intent}{language === "zh" ? "：" : ": "}{call.intent}</p>}
      </>
    }
  }
}
