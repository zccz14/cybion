import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { threadHistoryRecordKey, threadImage, type HistoryRecord } from "@/lib/thread-history"

const copy = {
  en: { open: "Open image", generated: "Generated image", screenshot: "Screenshot" },
  zh: { open: "查看图片", generated: "生成的图片", screenshot: "屏幕截图" },
} as const

export function ThreadImageGroup({ language, images }: { language: "en" | "zh"; images: readonly HistoryRecord[] }) {
  const text = copy[language]
  return <div data-slot="thread-image-group" className="flex min-w-0 flex-wrap gap-2">
    {images.map((record) => {
      const image = threadImage(record)
      if (image === null) return null
      return <ThreadImage
        key={threadHistoryRecordKey(record)}
        language={language}
        label={image.kind === "generated" ? text.generated : text.screenshot}
        source={image.source}
      />
    })}
  </div>
}

function ThreadImage({ language, label, source }: { language: "en" | "zh"; label: string; source: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-label={copy[language].open} className="cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => setOpen(true)}>
      <img src={source} alt={label} loading="lazy" decoding="async" className="block max-h-72 w-auto max-w-full rounded-lg border bg-muted" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <img src={source} alt={label} className="max-h-[70vh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  </>
}
