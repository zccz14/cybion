import { MicIcon, SquareIcon, XIcon } from "lucide-react"
import { useRef } from "react"

import { Button } from "@/components/ui/button"
import { audioAttachmentSize } from "@/lib/composer-audio"

const copy = {
  en: {
    record: "Record audio",
    stop: "Stop recording",
    upload: "Attach audio",
    recording: "Recording",
    attachment: "Audio",
    remove: "Remove audio",
  },
  zh: {
    record: "录制音频",
    stop: "停止录音",
    upload: "添加音频",
    recording: "正在录音",
    attachment: "音频",
    remove: "移除音频",
  },
} as const

export function ComposerAudio({
  language,
  audios,
  recording,
  disabled,
  onStart,
  onStop,
  onAdd,
  onRemove,
}: {
  language: "en" | "zh"
  audios: string[]
  recording: boolean
  disabled: boolean
  onStart: () => Promise<boolean>
  onStop: () => void
  onAdd: (files: File[]) => Promise<void>
  onRemove: (index: number) => void
}) {
  const t = copy[language]
  const picker = useRef<HTMLInputElement | null>(null)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {recording ? (
        <Button type="button" variant="destructive" size="sm" onClick={onStop}>
          <SquareIcon data-icon="inline-start" />
          {t.stop}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => void onStart()}
        >
          <MicIcon data-icon="inline-start" />
          {t.record}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || recording}
        onClick={() => picker.current?.click()}
      >
        {t.upload}
      </Button>
      <input
        ref={picker}
        type="file"
        accept="audio/*,.m4a,.webm,.wav,.mp3,.ogg,.flac,.aac"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          if (files.length > 0) void onAdd(files)
        }}
      />
      {audios.map((dataUrl, index) => (
        <span
          key={index}
          className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs"
        >
          {t.attachment} · {audioAttachmentSize(dataUrl)}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t.remove}
            onClick={() => onRemove(index)}
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      ))}
    </div>
  )
}
