import type { AudioTranscriptionFunctionCall } from "../lib/history-payload"
import type { Language } from "../api"

export function AudioTranscriptionCall({ language, call, time }: {
  language: Language
  call: AudioTranscriptionFunctionCall
  time: string
}) {
  const zh = language === "zh"
  return <div className="flex w-fit max-w-full flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{zh ? "语音转写" : "Speech-to-text"}</span>
      {call.model && <span>{call.model}</span>}
      {call.language && <span>{call.language}</span>}
      <span>{time}</span>
    </div>
    {call.prompt && <p className="whitespace-pre-wrap break-words text-xs">{call.prompt}</p>}
    {call.keywords.length > 0 && <p className="break-words text-xs text-muted-foreground">{call.keywords.join(" · ")}</p>}
    <p className="font-mono text-xs text-muted-foreground">{`audio_ref ${call.audioRef.slice(0, 12)}…`}</p>
  </div>
}
