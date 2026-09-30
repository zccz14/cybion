import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const copy = {
  en: { image: "Screenshot", open: "Open screenshot" },
  zh: { image: "屏幕截图", open: "查看截图" },
} as const

export function ScreenshotOutput({ language, source }: { language: "en" | "zh"; source: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-label={copy[language].open} className="mt-2 block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => setOpen(true)}>
      <img src={source} alt={copy[language].image} loading="lazy" decoding="async" className="block max-h-72 w-auto max-w-full rounded-lg border bg-muted" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{copy[language].image}</DialogTitle></DialogHeader>
        <img src={source} alt={copy[language].image} className="max-h-[70vh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  </>
}
