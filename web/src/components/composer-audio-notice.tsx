import type { ComposerAudioError } from "@/hooks/use-composer-audio"

const copy = {
  en: {
    unsupported: "This environment cannot record audio. Open Cybion in a normal tab to record.",
    denied: "The browser refused the microphone. Allow it for Cybion in the extension details, then try again.",
    deniedFramed: "A web page this panel hosts cannot use the microphone. Use the microphone button at the bottom-left of the panel instead.",
    "no-device": "No microphone was found.",
    unknown: "Recording could not start. The console has the reason.",
  },
  zh: {
    unsupported: "这个环境不能录音。用普通标签页打开 Cybion 再录。",
    denied: "浏览器拒绝了麦克风。去扩展详情里把麦克风允许给 Cybion，再试一次。",
    deniedFramed: "这个面板里的网页用不了麦克风，请用面板左下角的麦克风按钮录音。",
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
  // 被嵌在侧边栏里时，网页这一侧注定拿不到麦克风；指给用户面板上那个能用的按钮。
  const framed = typeof window !== "undefined" && window.self !== window.top
  const message = framed && error === "denied" ? copy[language].deniedFramed : copy[language][error]
  return (
    <p role="status" className="text-xs text-destructive">
      {message}
    </p>
  )
}
