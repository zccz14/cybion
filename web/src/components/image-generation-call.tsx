import type { ReactNode } from "react"
import { ImageIcon } from "lucide-react"
import type { ImageGenerationFunctionCall } from "@/lib/history-payload"

const copy = {
  en: {
    title: "Image generation",
    referenceImages: (positions: number[]) => `Reference images: ${positions.map((position) => `#${position}`).join(", ")}`,
    referenceImagesHint: "One-based positions of the pictures attached to this turn's input.",
  },
  zh: {
    title: "图像生成",
    referenceImages: (positions: number[]) => `参考图片：${positions.map((position) => `#${position}`).join("、")}`,
    referenceImagesHint: "本轮输入所附图片的序号（从 1 开始）。",
  },
} as const

export function ImageGenerationCall({ language, call, time, children }: {
  language: "en" | "zh"
  call: ImageGenerationFunctionCall
  time: string
  children: ReactNode
}) {
  const text = copy[language]
  const references = call.referenceImages.length > 0 ? text.referenceImages(call.referenceImages) : null
  return <div className="relative flex items-start gap-3 px-1">
    <div aria-hidden="true" className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground ring-1 ring-border">
      <ImageIcon className="size-4" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{text.title}</span>
        <time className="text-xs text-muted-foreground">{time}</time>
      </div>
      <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-3 py-2 text-sm leading-6">{call.prompt}</p>
      {references !== null && <p className="mt-1.5 text-xs text-muted-foreground" title={text.referenceImagesHint}>{references}</p>}
      {children}
    </div>
  </div>
}
