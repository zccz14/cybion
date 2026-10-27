import { MicIcon, SendIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

const copy = {
  en: {
    record: "Record a voice message",
    send: "Send voice message",
    cancel: "Cancel recording",
  },
  zh: {
    record: "录制语音",
    send: "发送语音",
    cancel: "取消录音",
  },
} as const

/// The composer's voice control: one microphone button that turns into a
/// send/cancel pair while recording. It sits in the toolbar between the
/// compaction button and the send button. Picking an audio file stays available
/// through `useComposerAudio().add` for a future attachment entry point, so the
/// composer no longer spends a second button on it.
export function ComposerAudio({
  language,
  recording,
  disabled,
  onStart,
  onSend,
  onCancel,
}: {
  language: "en" | "zh"
  recording: boolean
  disabled: boolean
  onStart: () => Promise<boolean>
  onSend: () => void
  onCancel: () => void
}) {
  const t = copy[language]
  if (recording) return <>
    <Button type="button" size="icon" aria-label={t.send} title={t.send} onClick={onSend}>
      <SendIcon />
    </Button>
    <Button type="button" size="icon" variant="outline" aria-label={t.cancel} title={t.cancel} onClick={onCancel}>
      <XIcon />
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
