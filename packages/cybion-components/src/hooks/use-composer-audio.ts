import { useCallback, useEffect, useRef, useState } from "react"
import type { Dispatch, SetStateAction } from "react"
import { audioDataUrlTooLarge, audioFileDataUrl, audioTooLarge, maxAudioBytes, recordingFile } from "../lib/composer-audio"

const ATTACH_EVENT = "cybion:attach-audio"
const pendingAudio: string[] = []

/// 录音的第二个来路：侧边栏（扩展页）有麦克风权限，网页里没有。它把录好的
/// data URL 递进来；composer 还没挂载时先排队，挂载时一并取走。
export function attachComposerAudio(dataUrls: string[]) {
  if (dataUrls.length === 0) return
  pendingAudio.push(...dataUrls)
  window.dispatchEvent(new Event(ATTACH_EVENT))
}

/// 一次录音的可见阶段。等待授权和收尾处理都不是瞬间完成的，这段时间按钮如果
/// 看起来和「没录」一样，用户就只能猜：所以在录的和正在处理的都要看得见。
export type ComposerAudioPhase = "idle" | "starting" | "recording" | "finalizing"

/// 录音为什么没成功。开始时就失败的和录完才失败的要分开说，否则用户不知道该
/// 去改权限，还是该重录一遍。
export type ComposerAudioError =
  | "unsupported"
  | "denied"
  | "no-device"
  | "busy"
  | "unknown"
  /// 录完才发现的：空录音、超上限、读不出字节、被系统打断。
  | "empty"
  | "too-large"
  | "unreadable"
  | "interrupted"

function startFailure(failure: unknown): ComposerAudioError {
  const name = (failure as { name?: string } | null)?.name ?? ""
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied"
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no-device"
  // 麦克风被别的程序占着，或者驱动给不出轨道：这既不是权限也不是没设备。
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy"
  return "unknown"
}

/// Audio attachments for one composer: recording through the browser's
/// MediaRecorder plus files picked from disk, both held as data URLs until the
/// input is sent.
export function useComposerAudio(): {
  audios: string[]
  phase: ComposerAudioPhase
  recording: boolean
  /// 正在录的这一段已经说了多少秒；录音按钮旁边那行计时用它。
  elapsed: number
  /// 录音没成功的原因；不解释清楚，这个按钮就是个哑巴。
  error: ComposerAudioError | null
  start: () => Promise<boolean>
  /// Stops the recorder and hands the clip back as a data URL. A take that
  /// produced nothing says so through `error` instead of resolving silently.
  finish: () => Promise<string | null>
  /// Stops the recorder and throws the clip away.
  cancel: () => void
  add: (files: File[]) => Promise<void>
  /// 把刚录好的一段挂进附件：发送失败时它还在输入框上，重试不用重录。
  attach: (dataUrl: string) => void
  remove: (index: number) => void
  clear: () => void
  dismissError: () => void
} {
  const [audios, setAudios] = useState<string[]>([])
  const [phase, setPhase] = useState<ComposerAudioPhase>("idle")
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<ComposerAudioError | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const settle = useRef<((value: string | null) => void) | null>(null)
  const discard = useRef(false)
  const failed = useRef(false)

  useEffect(() => {
    if (phase !== "recording" || startedAt === null) return
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    update()
    const timer = window.setInterval(update, 500)
    return () => window.clearInterval(timer)
  }, [phase, startedAt])

  useEffect(
    () => () => {
      settle.current?.(null)
      settle.current = null
      if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop()
      stream.current?.getTracks().forEach((track) => track.stop())
    },
    []
  )

  const attach = useCallback((dataUrl: string) => {
    if (audioDataUrlTooLarge(dataUrl)) {
      setError("too-large")
      return
    }
    setError(null)
    setAudios((current) => [...current, dataUrl])
  }, [])

  const add = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const accepted = files.filter((file) => !audioTooLarge(file))
    const dataUrls = await Promise.all(accepted.map(audioFileDataUrl))
    const ready = dataUrls.filter((dataUrl): dataUrl is string => dataUrl !== null)
    if (ready.length > 0) setAudios((current) => [...current, ...ready])
    // 被拒的文件以前是悄悄消失的：说清楚是超了上限还是读不出来。
    if (accepted.length < files.length) setError("too-large")
    else if (ready.length < dataUrls.length) setError("unreadable")
  }, [])

  const drainAttached = useCallback(() => {
    if (pendingAudio.length === 0) return
    const incoming = pendingAudio.splice(0, pendingAudio.length)
    const ready = incoming.filter((dataUrl) => !audioDataUrlTooLarge(dataUrl))
    if (ready.length > 0) setAudios((current) => [...current, ...ready])
    if (ready.length < incoming.length) setError("too-large")
  }, [])

  useEffect(() => {
    drainAttached()
    window.addEventListener(ATTACH_EVENT, drainAttached)
    return () => window.removeEventListener(ATTACH_EVENT, drainAttached)
  }, [drainAttached])

  const start = useCallback(async () => {
    if (recorder.current) return false
    setError(null)
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      // 没有 mediaDevices 只可能是非安全上下文或不支持的环境。
      setError("unsupported")
      return false
    }
    setPhase("starting")
    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (failure) {
      // 权限被拒、没有设备、被扩展页的策略拦住……都得说出来，不然用户只看到按钮没反应。
      setPhase("idle")
      setError(startFailure(failure))
      console.warn("[cybion] 无法开始录音", failure)
      return false
    }
    stream.current = mediaStream
    chunks.current = []
    discard.current = false
    failed.current = false
    const next = new MediaRecorder(mediaStream)
    recorder.current = next
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data)
    }
    next.onerror = () => {
      // 录到一半设备被抽走（拔了麦克风、系统收回权限、来电打断）：先记下来，
      // 紧接着的 stop 会把这段作废并说明原因，而不是假装录完了。
      failed.current = true
    }
    next.onstop = () => {
      const blob = new Blob(chunks.current, { type: next.mimeType || "audio/webm" })
      chunks.current = []
      mediaStream.getTracks().forEach((track) => track.stop())
      stream.current = null
      recorder.current = null
      setStartedAt(null)
      setPhase("idle")
      const resolve = settle.current
      settle.current = null
      if (discard.current) {
        discard.current = false
        resolve?.(null)
        return
      }
      if (failed.current) {
        failed.current = false
        setError("interrupted")
        resolve?.(null)
        return
      }
      if (blob.size === 0) {
        setError("empty")
        resolve?.(null)
        return
      }
      if (blob.size > maxAudioBytes) {
        setError("too-large")
        resolve?.(null)
        return
      }
      void audioFileDataUrl(recordingFile(blob, Date.now())).then((dataUrl) => {
        if (dataUrl === null) {
          setError("unreadable")
          resolve?.(null)
          return
        }
        if (audioDataUrlTooLarge(dataUrl)) {
          setError("too-large")
          resolve?.(null)
          return
        }
        resolve?.(dataUrl)
      })
    }
    // 每秒切一块：长录音不会攒成一个巨大的 Blob 才落盘，中途被打断也能看出长度。
    next.start(1000)
    setStartedAt(Date.now())
    setElapsed(0)
    setPhase("recording")
    return true
  }, [])

  const finish = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        const current = recorder.current
        if (!current || current.state === "inactive") {
          // 按钮只在录音阶段出现，走到这里说明这段录音已经没了：说出来，别让它无声消失。
          setError("empty")
          resolve(null)
          return
        }
        setPhase("finalizing")
        settle.current = resolve
        current.stop()
      }),
    []
  )

  const cancel = useCallback(() => {
    setError(null)
    const current = recorder.current
    if (!current || current.state === "inactive") {
      setStartedAt(null)
      setPhase("idle")
      return
    }
    discard.current = true
    settle.current = null
    current.stop()
  }, [])

  const remove = useCallback((index: number) => {
    setAudios((current) => current.filter((_, currentIndex) => currentIndex !== index))
  }, [])
  const clear = useCallback(() => setAudios([]), [])
  const dismissError = useCallback(() => setError(null), [])

  return {
    audios,
    phase,
    recording: phase === "recording",
    elapsed,
    error,
    start,
    finish,
    cancel,
    add,
    attach,
    remove,
    clear,
    dismissError,
  }
}

export type ComposerAudioState = ReturnType<typeof useComposerAudio>
export type ComposerAudioSetter = Dispatch<SetStateAction<string[]>>
