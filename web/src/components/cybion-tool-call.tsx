import type { ReactNode } from "react"
import { WrenchIcon } from "lucide-react"
import { Link } from "react-router-dom"
import type { CybionToolFunctionCall } from "@/lib/history-payload"

const copy = {
  en: {
    listManuals: "List manuals", listWorkers: "List Workers", loadManual: "Load manual", unloadManual: "Unload manual", writeManual: "Edit manual", createManual: "Create manual", parent: "Parent", movedToTrash: "Moved to trash", listMachines: "List Ultimate Machines",
    getMachine: "Read Ultimate Machine", updateMachine: "Update Ultimate Machine", createMachine: "Create Ultimate Machine", deleteMachine: "Delete Ultimate Machine",
    name: "Name", worker: "Worker", interval: "Interval", state: "State", enabled: "Enabled", paused: "Paused", command: "Command", intent: "Intent",
    addNotes: "Add notes", crossOutNotes: "Cross out notes",
  },
  zh: {
    listManuals: "列出手册", listWorkers: "列出 Worker", loadManual: "加载手册", unloadManual: "卸载手册", writeManual: "编辑手册", createManual: "新建手册", parent: "父级", movedToTrash: "已移入回收站", listMachines: "列出终极机器",
    getMachine: "读取终极机器", updateMachine: "更新终极机器", createMachine: "创建终极机器", deleteMachine: "删除终极机器",
    name: "名称", worker: "Worker", interval: "间隔", state: "状态", enabled: "启用", paused: "已暂停", command: "命令", intent: "意图",
    addNotes: "添加便签", crossOutNotes: "划掉便签",
  },
} as const

const monoBlock = "mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5"

// A manual id resolves to its title and its Use When description through the
// same caches the Manuals page fills; an id that does not resolve keeps the
// monospace id rendering.
export type ManualSummary = { name: string; description: string }

export function CybionToolCall({ language, call, workers, manuals, time, children }: {
  language: "en" | "zh"
  call: CybionToolFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
  manuals: ReadonlyMap<string, ManualSummary> | undefined
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  const title = (() => {
    switch (call.tool) {
      case "load_manual": return text.loadManual
      case "unload_manual": return text.unloadManual
      case "write_manual": return call.manualId !== null ? text.writeManual : text.createManual
      case "list_manuals": return text.listManuals
      case "cybion_list_workers": return text.listWorkers
      case "cybion_list_ultimate_machines": return text.listMachines
      case "cybion_get_ultimate_machine": return text.getMachine
      case "cybion_set_ultimate_machine": return call.machineId !== null ? text.updateMachine : text.createMachine
      case "cybion_delete_ultimate_machine": return text.deleteMachine
      case "add_notes": return text.addNotes
      case "cross_out_notes": return text.crossOutNotes
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
      <CybionToolDetail language={language} call={call} workers={workers} manuals={manuals} />
      {children}
    </div>
  </div>
}

function CybionToolDetail({ language, call, workers, manuals }: {
  language: "en" | "zh"
  call: CybionToolFunctionCall
  workers: readonly { id: string; label: string }[] | undefined
  manuals: ReadonlyMap<string, ManualSummary> | undefined
}) {
  const text = copy[language]
  switch (call.tool) {
    case "load_manual":
    case "unload_manual": {
      const manual = manuals?.get(call.manualId) ?? null
      if (manual === null) return <pre className={monoBlock}>{call.manualId}</pre>
      return <>
        <Link className="mt-2 block w-fit text-sm font-medium hover:underline" title={call.manualId} to={`/manuals?manual=${encodeURIComponent(call.manualId)}`}>{manual.name}</Link>
        {manual.description !== "" && <p className="mt-1.5 text-xs text-muted-foreground">{manual.description}</p>}
      </>
    }
    case "write_manual": {
      if (call.manualId === null) {
        const parent = call.parentId === null ? null : manuals?.get(call.parentId) ?? null
        return <>
          {call.name !== null && <p className="mt-2 text-sm font-medium">{call.name}</p>}
          {call.parentId !== null && (parent === null
            ? <pre className={monoBlock}>{call.parentId}</pre>
            : <Link className="mt-1.5 block w-fit text-xs text-muted-foreground hover:underline" to={`/manuals?manual=${encodeURIComponent(call.parentId)}`}>{text.parent}{language === "zh" ? "：" : ": "}{parent.name}</Link>)}
        </>
      }
      const manual = manuals?.get(call.manualId) ?? null
      return <>
        {manual === null
          ? <pre className={monoBlock}>{call.manualId}</pre>
          : <Link className="mt-2 block w-fit text-sm font-medium hover:underline" title={call.manualId} to={`/manuals?manual=${encodeURIComponent(call.manualId)}`}>{manual.name}</Link>}
        {manual !== null && manual.description !== "" && <p className="mt-1.5 text-xs text-muted-foreground">{manual.description}</p>}
        {call.trashed && <p className="mt-1.5 text-xs text-muted-foreground">{text.movedToTrash}</p>}
      </>
    }
    case "cybion_get_ultimate_machine":
    case "cybion_delete_ultimate_machine":
      return <pre className={monoBlock}>{call.machineId}</pre>
    case "add_notes":
      return <ul className="mt-2 space-y-1">{call.texts.map((note) => <li key={note} className="break-words text-sm">{note}</li>)}</ul>
    case "cross_out_notes":
      return <ul className="mt-2 space-y-1 font-mono text-xs">{call.noteIds.map((id) => <li key={id}>{id}</li>)}</ul>
    case "list_manuals":
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
