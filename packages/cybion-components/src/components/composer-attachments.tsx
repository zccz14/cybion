import { FileTextIcon, XIcon } from "lucide-react"
import { Button } from "../ui/button"
import { audioAttachmentSize } from "../lib/composer-audio"
import { formatBytes } from "../lib/format"
import type { ComposerFile } from "../lib/composer-files"

const copy = {
  en: {
    image: "Pasted image", remove: "Remove image", audio: "Audio", removeAudio: "Remove audio",
    removeFile: "Remove attachment", truncated: "cut to fit",
  },
  zh: {
    image: "粘贴的图片", remove: "移除图片", audio: "音频", removeAudio: "移除音频",
    removeFile: "移除附件", truncated: "已截断",
  },
} as const

/// Everything the composer will send besides the typed text: pasted or picked
/// images, audio clips waiting to go out, and text files attached through the [+]
/// button. The controls themselves live in the toolbar, so an attachment never
/// adds a button of its own.
export function ComposerAttachments({
  language,
  images,
  audios = [],
  files = [],
  onRemove,
  onRemoveAudio = () => undefined,
  onRemoveFile = () => undefined,
}: {
  language: "en" | "zh"
  images: string[]
  audios?: string[]
  files?: ComposerFile[]
  onRemove: (index: number) => void
  onRemoveAudio?: (index: number) => void
  onRemoveFile?: (index: number) => void
}) {
  if (images.length === 0 && audios.length === 0 && files.length === 0) return null
  const t = copy[language]
  return <div className="flex flex-wrap items-center gap-2">
    {images.map((dataUrl, index) => <div className="relative" key={index}>
      <img src={dataUrl} alt={t.image} className="h-16 w-28 rounded-md border bg-muted object-cover" />
      <Button type="button" size="icon-sm" variant="secondary" className="absolute -top-2 -right-2 size-5 rounded-full shadow-sm" aria-label={t.remove} onClick={() => onRemove(index)}>
        <XIcon className="size-3" />
      </Button>
    </div>)}
    {audios.map((dataUrl, index) => <span key={index} className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
      {t.audio} · {audioAttachmentSize(dataUrl)}
      <Button type="button" size="icon-sm" variant="ghost" aria-label={t.removeAudio} onClick={() => onRemoveAudio(index)}>
        <XIcon className="size-3" />
      </Button>
    </span>)}
    {files.map((file, index) => <span key={index} className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs" title={file.name}>
      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-40 truncate">{file.name}</span>
      <span className="shrink-0 text-muted-foreground">{formatBytes(file.bytes)}{file.truncated && ` · ${t.truncated}`}</span>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t.removeFile}: ${file.name}`} onClick={() => onRemoveFile(index)}>
        <XIcon className="size-3" />
      </Button>
    </span>)}
  </div>
}
