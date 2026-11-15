import type { ComposerAudioError } from "../hooks/use-composer-audio"

const copy = {
  en: {
    unsupported: "This environment cannot record audio. Open Cybion in a normal tab to record.",
    denied: "The browser refused the microphone. Allow it for Cybion in the extension details, then try again.",
    deniedFramed: "A web page this panel hosts cannot use the microphone. Use the microphone button at the bottom-left of the panel instead.",
    "no-device": "No microphone was found.",
    busy: "Another application is holding the microphone. Close it and record again.",
    unknown: "Recording could not start. The console has the reason.",
    restored: (count: number) => `${count === 1 ? "1 voice clip is" : `${count} voice clips are`} still unsent and came back from the local draft.`,
    sendAnyway: "Send now",
    empty: "This take captured no sound, so nothing was sent. Watch the timer while you speak; if it is not moving, the microphone is not recording.",
    "too-large": "That recording is over the 20 MB limit, so it was not sent. Split it into shorter clips.",
    unreadable: "The recording could not be read back from the browser. Please record it again.",
    interrupted: "The microphone was taken away mid-take (device unplugged, permission withdrawn, or a call). That clip was not recorded; please record again.",
  },
  zh: {
    unsupported: "这个环境不能录音。用普通标签页打开 Cybion 再录。",
    denied: "浏览器拒绝了麦克风。去扩展详情里把麦克风允许给 Cybion，再试一次。",
    deniedFramed: "这个面板里的网页用不了麦克风，请用面板左下角的麦克风按钮录音。",
    "no-device": "没有找到可用的麦克风。",
    busy: "麦克风被别的程序占用了。关掉它再录一次。",
    unknown: "录音没能开始，具体原因看控制台。",
    restored: (count: number) => (count === 1 ? "有 1 段语音还没发出，已从本地草稿恢复。" : `有 ${count} 段语音还没发出，已从本地草稿恢复。`),
    sendAnyway: "现在发送",
    empty: "这一段没有录到任何声音，所以没有发出。录音时留意按钮旁的计时器：它不走，就是没在录。",
    "too-large": "这段录音超过 20 MB 上限，没有发出。分几段短的说吧。",
    unreadable: "浏览器读不回这段录音，请重录一次。",
    interrupted: "录音中途被系统拿走了麦克风（拔了设备、权限被收回或来了电话），这段没有录上，请重录。",
  },
} as const

/// 录音按钮以前失败时什么都不说，用户只看到“点了没反应”。这里把原因摆出来。
export function ComposerAudioNotice({
  language,
  error,
  onDismiss,
  restored = 0,
  onDismissRestored,
  onRetry,
}: {
  language: "en" | "zh"
  error: ComposerAudioError | null
  onDismiss?: () => void
  /// 从本地草稿捡回来的未发段数：这些音还在，但没人说一声用户以为丢了。
  restored?: number
  onDismissRestored?: () => void
  /// 重发这段草稿（发送失败后仍然有效，因为音频还挂在输入框上）。
  onRetry?: () => void
}) {
  if (restored > 0) {
    return (
      <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{copy[language].restored(restored)}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="shrink-0 underline underline-offset-2 hover:text-foreground">
            {copy[language].sendAnyway}
          </button>
        )}
        {onDismissRestored && (
          <button type="button" onClick={onDismissRestored} className="shrink-0 underline underline-offset-2 opacity-80 hover:opacity-100">
            {language === "zh" ? "知道了" : "Dismiss"}
          </button>
        )}
      </p>
    )
  }
  if (!error) return null
  // 被嵌在侧边栏里时，网页这一侧注定拿不到麦克风；指给用户面板上那个能用的按钮。
  const framed = typeof window !== "undefined" && window.self !== window.top
  const message = framed && error === "denied" ? copy[language].deniedFramed : copy[language][error]
  return (
    <p role="status" className="flex items-start gap-2 text-xs text-destructive">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 underline underline-offset-2 opacity-80 hover:opacity-100">
          {language === "zh" ? "知道了" : "Dismiss"}
        </button>
      )}
    </p>
  )
}
