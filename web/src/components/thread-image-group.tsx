import { useState } from "react"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { threadHistoryRecordKey, threadImage, type HistoryRecord } from "@/lib/thread-history"

const copy = {
  en: { open: "Open image", generated: "Generated image", screenshot: "Screenshot" },
  zh: { open: "查看图片", generated: "生成的图片", screenshot: "屏幕截图" },
} as const

export function ThreadImageGroup({ language, images }: { language: "en" | "zh"; images: readonly HistoryRecord[] }) {
  const text = copy[language]
  const files = images.flatMap((record) => {
    const image = threadImage(record)
    if (image === null) return []
    return [{ key: threadHistoryRecordKey(record), label: image.kind === "generated" ? text.generated : text.screenshot, source: image.source }]
  })
  return <div data-slot="thread-image-group" className="min-w-0 max-w-xl">
    <Carousel opts={{ align: "start" }}>
      <CarouselContent>
        {files.map((file) => <CarouselItem key={file.key}>
          <ThreadImage language={language} label={file.label} source={file.source} />
        </CarouselItem>)}
      </CarouselContent>
      {files.length > 1 && <>
        <CarouselPrevious className="left-2" />
        <CarouselNext className="right-2" />
      </>}
    </Carousel>
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
