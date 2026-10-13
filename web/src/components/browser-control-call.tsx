import type { ReactNode } from "react"
import { AppWindowIcon } from "lucide-react"
import type { BrowserControlFunctionCall } from "@/lib/history-payload"

const copy = {
  en: { title: "Browser control", open: "Open page", evaluate: "Evaluate script", click: "Click element", type: "Type text", screenshot: "Capture a screenshot", selector: "Selector" },
  zh: { title: "浏览器控制", open: "打开网页", evaluate: "执行脚本", click: "点击元素", type: "输入文本", screenshot: "截取屏幕截图", selector: "选择器" },
} as const

const monoBlock = "mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5"

export function BrowserControlCall({ language, call, time, children }: {
  language: "en" | "zh"
  call: BrowserControlFunctionCall
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <AppWindowIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{text.title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <BrowserControlDetail language={language} call={call} />
      {children}
    </div>
  </div>
}

function BrowserControlDetail({ language, call }: { language: "en" | "zh"; call: BrowserControlFunctionCall }) {
  const text = copy[language]
  switch (call.action) {
    case "navigate":
    case "open":
      return <>
        <p className="mt-2 text-sm text-muted-foreground">{text.open}</p>
        <pre className={monoBlock}>{call.url}</pre>
      </>
    case "evaluate":
      return <>
        <p className="mt-2 text-sm text-muted-foreground">{text.evaluate}</p>
        <pre className={monoBlock}>{call.text}</pre>
      </>
    case "click":
      return <>
        <p className="mt-2 text-sm text-muted-foreground">{text.click}</p>
        <pre className={monoBlock}>{call.selector}</pre>
      </>
    case "type":
      return <>
        <p className="mt-2 text-sm text-muted-foreground">{text.type}</p>
        <pre className={monoBlock}>{call.text}</pre>
        <p className="mt-1.5 text-xs text-muted-foreground">{text.selector}{language === "zh" ? "：" : ": "}<code className="font-mono">{call.selector}</code></p>
      </>
    case "screenshot":
      return <p className="mt-2 text-sm text-muted-foreground">{text.screenshot}</p>
  }
}
