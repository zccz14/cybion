import type { ReactNode } from "react"
import { ImageIcon } from "lucide-react"
import type { ViewImageFunctionCall } from "@/lib/history-payload"

const copy = {
  en: { title: "View an image", path: "Image path" },
  zh: { title: "查看图片", path: "图片路径" },
} as const

const monoBlock = "mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 font-mono text-xs leading-5"

export function ViewImageCall({ language, call, time, children }: {
  language: "en" | "zh"
  call: ViewImageFunctionCall
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <ImageIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{text.title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{text.path}</p>
      <pre className={monoBlock}>{call.path}</pre>
      {children}
    </div>
  </div>
}
