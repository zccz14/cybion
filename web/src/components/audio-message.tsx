import { PauseIcon, PlayIcon } from "lucide-react"
import { useRef, useState } from "react"

import { audioDurationLabel } from "@/lib/composer-audio"

const copy = {
  en: { play: "Play voice message", pause: "Pause voice message" },
  zh: { play: "播放语音", pause: "暂停语音" },
} as const

// Fixed heights keep the waveform identical between renders; it marks the bubble
// as a voice message without pretending to be a real amplitude envelope.
const bars = [6, 11, 15, 8, 13, 7, 16, 10, 14, 9]

/// One sent audio input, drawn as a voice bar: the whole row is the play/pause
/// control, the waveform animates while it plays and the label shows its length.
export function AudioMessage({ language, dataUrl }: { language: "en" | "zh"; dataUrl: string }) {
  const t = copy[language]
  const player = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [seconds, setSeconds] = useState<number | null>(null)
  const toggle = () => {
    const element = player.current
    if (!element) return
    if (playing) {
      element.pause()
      element.currentTime = 0
      setPlaying(false)
      return
    }
    void element
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false))
  }
  // A streamed recording reports Infinity until the browser seeks past its end;
  // that seek is how the real length becomes known.
  const measure = (element: HTMLAudioElement) => {
    if (Number.isFinite(element.duration)) {
      setSeconds(element.duration)
      return
    }
    element.ontimeupdate = () => {
      element.ontimeupdate = null
      setSeconds(element.currentTime)
      element.currentTime = 0
    }
    element.currentTime = 1e101
  }
  return (
    <button
      type="button"
      data-slot="audio-message"
      aria-label={playing ? t.pause : t.play}
      aria-pressed={playing}
      onClick={toggle}
      className="flex items-center gap-2 rounded-lg bg-user-message px-3 py-2 text-user-message-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      style={{ width: seconds === null ? 168 : Math.min(320, 132 + Math.round(seconds) * 6) }}
    >
      {playing ? <PauseIcon className="size-4 shrink-0" /> : <PlayIcon className="size-4 shrink-0" />}
      <span aria-hidden className="flex h-4 items-end gap-0.5 opacity-70">
        {bars.map((height, index) => <span key={index} className={playing ? "w-0.5 rounded-full bg-current" : "w-0.5 rounded-full bg-current"} style={{ height }} />)}
      </span>
      <span className="ml-auto text-xs tabular-nums opacity-70">{audioDurationLabel(seconds)}</span>
      <audio
        ref={player}
        src={dataUrl}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={(event) => measure(event.currentTarget)}
        onEnded={() => setPlaying(false)}
      />
    </button>
  )
}
