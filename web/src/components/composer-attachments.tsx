import { XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { audioAttachmentSize } from "@/lib/composer-audio"

const copy = {
  en: { image: "Pasted image", remove: "Remove image", audio: "Audio", removeAudio: "Remove audio" },
  zh: { image: "粘贴的图片", remove: "移除图片", audio: "音频", removeAudio: "移除音频" },
} as const

/// Everything the composer will send besides the typed text: pasted images and
/// any audio clip waiting to go out. The voice control itself lives in the
/// toolbar, so a recording never adds a row of its own.
export function ComposerAttachments({ language, images, audios = [], onRemove, onRemoveAudio = () => undefined }: {
  language: "en" | "zh"
  images: string[]
  audios?: string[]
  onRemove: (index: number) => void
  onRemoveAudio?: (index: number) => void
}) {
  if (images.length === 0 && audios.length === 0) return null
  return <div className="flex flex-wrap items-center gap-2">
    {images.map((dataUrl, index) => <div className="relative" key={index}>
      <img src={dataUrl} alt={copy[language].image} className="h-16 w-28 rounded-md border bg-muted object-cover" />
      <Button type="button" size="icon-sm" variant="secondary" className="absolute -top-2 -right-2 size-5 rounded-full shadow-sm" aria-label={copy[language].remove} onClick={() => onRemove(index)}>
        <XIcon className="size-3" />
      </Button>
    </div>)}
    {audios.map((dataUrl, index) => <span key={index} className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
      {copy[language].audio} · {audioAttachmentSize(dataUrl)}
      <Button type="button" size="icon-sm" variant="ghost" aria-label={copy[language].removeAudio} onClick={() => onRemoveAudio(index)}>
        <XIcon className="size-3" />
      </Button>
    </span>)}
  </div>
}
