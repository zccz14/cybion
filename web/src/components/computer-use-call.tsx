import type { ReactNode } from "react"
import { MousePointerClickIcon } from "lucide-react"
import type { ComputerUseFunctionCall } from "@/lib/history-payload"

const copy = {
  en: { title: "Control the desktop", move: (x: number, y: number) => `Move the pointer to (${x}, ${y})`, click: (x: number, y: number) => `Click at (${x}, ${y})`, type: "Type text", screenshot: "Capture a screenshot" },
  zh: { title: "控制桌面", move: (x: number, y: number) => `移动鼠标到 (${x}, ${y})`, click: (x: number, y: number) => `点击 (${x}, ${y})`, type: "输入文本", screenshot: "截取屏幕截图" },
} as const

const monoBlock = "mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5"

export function ComputerUseCall({ language, call, time, children }: {
  language: "en" | "zh"
  call: ComputerUseFunctionCall
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <MousePointerClickIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{text.title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <ComputerUseDetail language={language} call={call} />
      {children}
    </div>
  </div>
}

function ComputerUseDetail({ language, call }: { language: "en" | "zh"; call: ComputerUseFunctionCall }) {
  const text = copy[language]
  switch (call.action) {
    case "move":
      return <p className="mt-2 text-sm text-muted-foreground">{text.move(call.x, call.y)}</p>
    case "click":
      return <p className="mt-2 text-sm text-muted-foreground">{text.click(call.x, call.y)}</p>
    case "type":
      return <>
        <p className="mt-2 text-sm text-muted-foreground">{text.type}</p>
        <pre className={monoBlock}>{call.text}</pre>
      </>
    case "screenshot":
      return <p className="mt-2 text-sm text-muted-foreground">{text.screenshot}</p>
  }
}
