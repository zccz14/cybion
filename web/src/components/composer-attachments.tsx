import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

const copy = {
  en: { image: "Pasted image", remove: "Remove image" },
  zh: { image: "粘贴的图片", remove: "移除图片" },
} as const

export function ComposerAttachments({ language, images, onRemove }: { language: "en" | "zh"; images: string[]; onRemove: (index: number) => void }) {
  if (images.length === 0) return null
  return <div className="flex flex-wrap gap-2">
    {images.map((dataUrl, index) => <div className="relative" key={index}>
      <img src={dataUrl} alt={copy[language].image} className="h-16 w-28 rounded-md border bg-muted object-cover" />
      <Button type="button" size="icon-sm" variant="secondary" className="absolute -top-2 -right-2 size-5 rounded-full shadow-sm" aria-label={copy[language].remove} onClick={() => onRemove(index)}>
        <XIcon className="size-3" />
      </Button>
    </div>)}
  </div>
}
