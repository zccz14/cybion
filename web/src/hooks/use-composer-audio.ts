import { useCallback, useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import { audioFileDataUrl, audioTooLarge, recordingFile } from "@/lib/composer-audio"

/// Audio attachments for one composer: recording through the browser's
/// MediaRecorder plus files picked from disk, both held as data URLs until the
/// input is sent.
export function useComposerAudio(): {
  audios: string[]
  recording: boolean
  start: () => Promise<boolean>
  stop: () => void
  add: (files: File[]) => Promise<void>
  remove: (index: number) => void
  clear: () => void
} {
  const [audios, setAudios] = useState<string[]>([])
  const [recording, setRecording] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(
    () => () => {
      if (recorder.current?.state !== "inactive") recorder.current?.stop()
      stream.current?.getTracks().forEach((track) => track.stop())
    },
    []
  )

  const add = useCallback(async (files: File[]) => {
    const accepted = files.filter((file) => !audioTooLarge(file))
    const dataUrls = await Promise.all(accepted.map(audioFileDataUrl))
    const ready = dataUrls.filter((dataUrl): dataUrl is string => dataUrl !== null)
    if (ready.length > 0) setAudios((current) => [...current, ...ready])
  }, [])

  const start = useCallback(async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) return false
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = mediaStream
      chunks.current = []
      const next = new MediaRecorder(mediaStream)
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data)
      }
      next.onstop = () => {
        const blob = new Blob(chunks.current, { type: next.mimeType || "audio/webm" })
        mediaStream.getTracks().forEach((track) => track.stop())
        stream.current = null
        recorder.current = null
        setRecording(false)
        if (blob.size > 0) void add([recordingFile(blob, Date.now())])
      }
      recorder.current = next
      next.start()
      setRecording(true)
      return true
    } catch {
      return false
    }
  }, [add])

  const stop = useCallback(() => recorder.current?.stop(), [])
  const remove = useCallback((index: number) => {
    setAudios((current) => current.filter((_, currentIndex) => currentIndex !== index))
  }, [])
  const clear = useCallback(() => setAudios([]), [])

  return { audios, recording, start, stop, add, remove, clear }
}

export type ComposerAudioState = ReturnType<typeof useComposerAudio>
export type ComposerAudioSetter = Dispatch<SetStateAction<string[]>>
