import { attachComposerImages } from "@zccz14/cybion-components"

/**
 * 浏览器扩展的侧边栏把本应用嵌在 iframe 里。跨域，扩展碰不到这里的组件状态，
 * 所以"截图自动进草稿"只能走一条 postMessage：扩展发 data URL，这里塞进附件。
 *
 * 只在被嵌的时候挂监听——站点自己开着的时候不接受任何陌生人塞图。
 */
export function listenForExtensionAttachments() {
  if (window.self === window.top) return
  window.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; images?: unknown } | null
    if (!data || data.type !== "cybion:attach-images" || !Array.isArray(data.images)) return
    const images = data.images.filter(
      (value): value is string => typeof value === "string" && value.startsWith("data:image/"),
    )
    if (images.length > 0) attachComposerImages(images)
  })
}
