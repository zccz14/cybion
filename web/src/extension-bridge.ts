import { attachComposerAudio, attachComposerImages } from "@zccz14/cybion-components"

/**
 * 浏览器扩展的侧边栏把本应用嵌在 iframe 里。跨域，扩展碰不到这里的组件状态，
 * 所以"截图自动进草稿"只能走一条 postMessage：扩展发 data URL，这里塞进附件。
 *
 * 只在被嵌的时候挂监听——站点自己开着的时候不接受任何陌生人塞图。
 * 扩展会重发（它收不到 ack 就一直试），所以这里按 data URL 去重。
 */
const seen = new Set<string>()

export function listenForExtensionAttachments() {
  if (window.self === window.top) return

  // 扩展开关的权限面板看不到，把关键能力报到父页面，出问题时有个证据。
  void Promise.resolve().then(() => {
    window.parent?.postMessage(
      {
        type: "cybion:capabilities",
        mediaDevices: Boolean(navigator.mediaDevices),
        mediaRecorder: Boolean(window.MediaRecorder),
        framed: true,
      },
      "*",
    )
  })

  window.addEventListener("message", (event) => {
    // 侧边栏录的音：网页里拿不到麦克风，扩展页里有，录完从这里递进来。
    const audio = event.data as { type?: unknown; audio?: unknown } | null
    if (audio?.type === "cybion:attach-audio" && Array.isArray(audio.audio)) {
      const clips = audio.audio.filter(
        (value): value is string => typeof value === "string" && value.startsWith("data:audio/"),
      )
      if (clips.length > 0) attachComposerAudio(clips)
      const source = event.source as Window | null
      source?.postMessage({ type: "cybion:attached-audio", count: clips.length }, "*")
      return
    }

    const data = event.data as { type?: unknown; images?: unknown } | null
    if (!data || data.type !== "cybion:attach-images" || !Array.isArray(data.images)) return
    const fresh = data.images.filter(
      (value): value is string =>
        typeof value === "string" && value.startsWith("data:image/") && !seen.has(value),
    )
    for (const image of fresh) {
      seen.add(image)
      if (seen.size > 20) seen.delete(seen.values().next().value as string)
    }
    if (fresh.length > 0) attachComposerImages(fresh)
    const source = event.source as Window | null
    source?.postMessage({ type: "cybion:attached-images", count: fresh.length }, "*")
  })
}
