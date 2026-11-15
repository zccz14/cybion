import { MicIcon, SendIcon, XIcon } from "lucide-react"

import { Button } from "../ui/button"
import { Spinner } from "../ui/spinner"
import { audioDurationLabel } from "../lib/composer-audio"
import type { ComposerAudioPhase } from "../hooks/use-composer-audio"

const copy = {
  en: {
    record: "Record a voice message",
    send: "Send voice message",
    cancel: "Cancel recording",
    starting: "Waiting for the microphone…",
    finalizing: "Preparing the recording…",
    elapsed: (label: string) => `Recording ${label}`,
  },
  zh: {
    record: "录制语音",
    send: "发送语音",
    cancel: "取消录音",
    starting: "正在请求麦克风…",
    finalizing: "正在处理录音…",
    elapsed: (label: string) => `正在录音 ${label}`,
  },
} as const

/// The composer's voice control: one microphone button that turns into a
/// send/cancel pair while recording. It sits in the toolbar between the
/// compaction button and the send button. Picking an audio file stays available
/// through `useComposerAudio().add` for a future attachment entry point, so the
/// composer no longer spends a second button on it.
///
/// Every phase says what it is doing. A silent button cannot tell "the browser
/// is asking for permission" from "you are being recorded" from "nothing
/// happened", and the cost of that confusion is a paragraph of lost speech.
export function ComposerAudio({
  language,
  recording,
  phase,
  elapsed = 0,
  disabled,
  onStart,
  onSend,
  onCancel,
}: {
  language: "en" | "zh"
  recording: boolean
  /// Defaults to the legacy boolean so an older host still renders correctly.
  phase?: ComposerAudioPhase
  elapsed?: number
  disabled: boolean
  onStart: () => Promise<boolean>
  onSend: () => void
  onCancel: () => void
}) {
  const t = copy[language]
  const current = phase ?? (recording ? "recording" : "idle")
  if (current === "recording") return <>
    <span role="status" className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
      <span aria-hidden className="size-2 animate-pulse rounded-full bg-destructive" />
      {t.elapsed(audioDurationLabel(elapsed))}
    </span>
    <Button type="button" size="icon" aria-label={t.send} title={t.send} onClick={onSend}>
      <SendIcon />
    </Button>
    <Button type="button" size="icon" variant="outline" aria-label={t.cancel} title={t.cancel} onClick={onCancel}>
      <XIcon />
    </Button>
  </>
  if (current === "starting" || current === "finalizing") return <>
    <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Spinner className="size-3" />
      {current === "starting" ? t.starting : t.finalizing}
    </span>
    <Button type="button" size="icon" variant="outline" aria-label={t.record} title={current === "starting" ? t.starting : t.finalizing} disabled>
      <MicIcon />
    </Button>
  </>
  return <Button
    type="button"
    size="icon"
    variant="outline"
    aria-label={t.record}
    title={t.record}
    disabled={disabled}
    onClick={() => void onStart()}
  >
    <MicIcon />
  </Button>
}
