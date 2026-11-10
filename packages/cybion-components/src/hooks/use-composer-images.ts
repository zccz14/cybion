import { useCallback, useEffect, useState } from "react"
import type { ClipboardEvent } from "react"
import { inputImageDataUrl, pastedImageFiles } from "../lib/composer-images"

/**
 * 图片的第二个来路：宿主要能把一张图直接放进输入框。
 *
 * 站点嵌在浏览器扩展的侧边栏里时，扩展跨域碰不到这里的组件状态，只能靠一条
 * postMessage 把截图递进来；而 postMessage 可能在 composer 挂载之前就到，所以
 * 先排进队列，挂载时一并取走，不会丢。
 */
const ATTACH_EVENT = "cybion:attach-images"
const pendingImages: string[] = []

export function attachComposerImages(images: string[]) {
  if (images.length === 0) return
  pendingImages.push(...images)
  window.dispatchEvent(new Event(ATTACH_EVENT))
}

export function useComposerImages() {
  const [images, setImages] = useState<string[]>([])
  const drain = useCallback(() => {
    if (pendingImages.length === 0) return
    const ready = pendingImages.splice(0, pendingImages.length)
    setImages((current) => [...current, ...ready])
  }, [])
  useEffect(() => {
    drain()
    window.addEventListener(ATTACH_EVENT, drain)
    return () => window.removeEventListener(ATTACH_EVENT, drain)
  }, [drain])
  const paste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedImageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void (async () => {
      const dataUrls = await Promise.all(files.map(inputImageDataUrl))
      const ready = dataUrls.filter((dataUrl): dataUrl is string => dataUrl !== null)
      if (ready.length > 0) setImages((current) => [...current, ...ready])
    })()
  }, [])
  const remove = useCallback((index: number) => {
    setImages((current) => current.filter((_, currentIndex) => currentIndex !== index))
  }, [])
  const clear = useCallback(() => setImages([]), [])
  return { images, paste, remove, clear }
}
