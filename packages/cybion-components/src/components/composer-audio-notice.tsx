import type { ComposerAudioError } from "../hooks/use-composer-audio"

const copy = {
  en: {
    unsupported: "This environment cannot record audio. Open Cybion in a normal tab to record.",
    denied: "The browser refused the microphone. The side panel is an extension page: allow the microphone for Cybion in the extension details.",
    "no-device": "No microphone was found.",
    unknown: "Recording could not start. The console has the reason.",
  },
  zh: {
    unsupported: "这个环境不能录音。用普通标签页打开 Cybion 再录。",
    denied: "浏览器拒绝了麦克风。侧边栏是扩展页：去扩展详情里把麦克风允许给 Cybion。",
    "no-device": "没有找到可用的麦克风。",
    unknown: "录音没能开始，具体原因看控制台。",
  },
} as const

/// 录音按钮以前失败时什么都不说，用户只看到“点了没反应”。这里把原因摆出来。
export function ComposerAudioNotice({
  language,
  error,
}: {
  language: "en" | "zh"
  error: ComposerAudioError | null
}) {
  if (!error) return null
  return (
    <p role="status" className="text-xs text-destructive">
      {copy[language][error]}
    </p>
  )
}
