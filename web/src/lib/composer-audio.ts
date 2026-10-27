// A recorded or uploaded audio attachment becomes one `input_audio` data URL.
// The Controller stores the bytes in the object store, transcribes them once,
// and keeps the reference so the model can re-extract terms with better hints.
const maxAudioBytes = 20 * 1024 * 1024

export function audioTooLarge(file: File): boolean {
  return file.size > maxAudioBytes
}

export function audioFileDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/// A finished MediaRecorder blob as a named file; the extension follows the
/// container the browser actually produced.
export function recordingFile(blob: Blob, index: number): File {
  const type = blob.type.startsWith("audio/") ? blob.type : "audio/webm"
  const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"
  return new File([blob], `recording-${index}.${extension}`, { type })
}

export function audioAttachmentSize(dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
  const bytes = Math.floor((base64.length * 3) / 4)
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/// A voice bar's length label. A MediaRecorder WebM often reports no duration at
/// first, so an unknown value stays an ellipsis instead of a wrong "0:00".
export function audioDurationLabel(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—"
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}
