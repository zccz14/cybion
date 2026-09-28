import { useCallback, useState } from "react"
import type { ClipboardEvent } from "react"
import { inputImageDataUrl, pastedImageFiles } from "@/lib/composer-images"

export function useComposerImages() {
  const [images, setImages] = useState<string[]>([])
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
