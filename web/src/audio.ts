const preferredMimeTypes = ['audio/webm; codecs=opus', 'audio/webm'] as const

export function preferredAudioMimeType(isTypeSupported: (mimeType: string) => boolean): string | undefined {
  return preferredMimeTypes.find(isTypeSupported)
}

export function audioFileName(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('mp4') || normalized.includes('m4a') || normalized.includes('aac')) return 'recording.m4a'
  if (normalized.includes('ogg')) return 'recording.ogg'
  return 'recording.webm'
}
