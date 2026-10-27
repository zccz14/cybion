import { PauseIcon, PlayIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { audioDurationLabel } from "@/lib/composer-audio"
import type { UserInputAudio } from "@/lib/history-payload"

const copy = {
  en: { play: "Play voice message", pause: "Pause voice message", unavailable: "Voice message unavailable", subtitle: "Subtitle" },
  zh: { play: "播放语音", pause: "暂停语音", unavailable: "语音无法播放", subtitle: "字幕" },
} as const

// Fixed heights keep the waveform identical between renders; it marks the bubble
// as a voice message without pretending to be a real amplitude envelope.
const bars = [6, 11, 15, 8, 13, 7, 16, 10, 14, 9]

/// One sent audio input: a voice bar you can play, with the first-pass
/// transcript underneath as a subtitle, so the words are readable without
/// pressing play.
///
/// History replays only an `audio_ref`, so the bytes are fetched once through
/// `loadAudio` (`GET /api/objects/{id}`); a fresh input that still carries its
/// data URL plays without any request.
export function AudioMessage({ language, audio, loadAudio }: {
  language: "en" | "zh"
  audio: UserInputAudio
  loadAudio?: (reference: string, mediaType: string | null) => Promise<string>
}) {
  const t = copy[language]
  const player = useRef<HTMLAudioElement>(null)
  const [src, setSrc] = useState(audio.audioUrl)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [seconds, setSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (src || !audio.audioRef || !loadAudio) return
    let live = true
    void loadAudio(audio.audioRef, audio.mediaType)
      .then((url) => { if (live) setSrc(url) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [audio.audioRef, audio.mediaType, loadAudio, src])
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
  return <div className="flex flex-col items-end gap-1">
    <button
      type="button"
      data-slot="audio-message"
      data-audio-ref={audio.audioRef ?? undefined}
      aria-label={failed ? t.unavailable : playing ? t.pause : t.play}
      aria-pressed={playing}
      disabled={!src}
      onClick={toggle}
      className="flex items-center gap-2 rounded-lg bg-user-message px-3 py-2 text-user-message-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      style={{ width: seconds === null ? 168 : Math.min(320, 132 + Math.round(seconds) * 6) }}
    >
      {playing ? <PauseIcon className="size-4 shrink-0" /> : <PlayIcon className="size-4 shrink-0" />}
      <span aria-hidden className="flex h-4 items-end gap-0.5 opacity-70">
        {bars.map((height, index) => <span key={index} className="w-0.5 rounded-full bg-current" style={{ height }} />)}
      </span>
      <span className="ml-auto text-xs tabular-nums opacity-70">{audioDurationLabel(seconds)}</span>
      {src && (
        <audio
          ref={player}
          src={src}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(event) => measure(event.currentTarget)}
          onEnded={() => setPlaying(false)}
        />
      )}
    </button>
    {audio.transcript && (
      <p
        data-slot="audio-transcript"
        title={audio.transcriptModel ? `${t.subtitle} · ${audio.transcriptModel}` : undefined}
        className="max-w-[75ch] whitespace-pre-wrap break-words px-1 text-xs leading-5 text-muted-foreground"
      >
        {audio.transcript}
      </p>
    )}
  </div>
}
