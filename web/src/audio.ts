export const WEBM_OPUS_MIME_TYPE = 'audio/webm;codecs=opus'
export const WEBM_OPUS_UNSUPPORTED_MESSAGE = 'This browser does not support WebM/Opus audio recording.'

export function requireWebmOpusMimeType(isTypeSupported: (mimeType: string) => boolean): string {
  if (!isTypeSupported(WEBM_OPUS_MIME_TYPE)) throw new Error(WEBM_OPUS_UNSUPPORTED_MESSAGE)
  return WEBM_OPUS_MIME_TYPE
}

export function audioFileName(mimeType: string): string {
  if (mimeType.toLowerCase().split(';', 1)[0] !== 'audio/webm') {
    throw new Error('Unsupported recorded audio format.')
  }
  return 'recording.webm'
}

export function transcriptionFormData(audio: Blob): FormData {
  const form = new FormData()
  form.append('file', audio, audioFileName(audio.type))
  return form
}
