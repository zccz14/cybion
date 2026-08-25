import assert from 'node:assert/strict'
import test from 'node:test'
import {
  audioFileName,
  requireWebmOpusMimeType,
  transcriptionFormData,
  WEBM_OPUS_MIME_TYPE,
  WEBM_OPUS_UNSUPPORTED_MESSAGE,
} from '../src/audio.ts'

test('requires the exact WebM/Opus recorder MIME type', () => {
  assert.equal(
    requireWebmOpusMimeType((mimeType) => mimeType === WEBM_OPUS_MIME_TYPE),
    WEBM_OPUS_MIME_TYPE,
  )
})

test('rejects recording when WebM/Opus is unavailable instead of falling back to a browser default', () => {
  assert.throws(
    () => requireWebmOpusMimeType(() => false),
    new Error(WEBM_OPUS_UNSUPPORTED_MESSAGE),
  )
})

test('transcription upload forwards a WebM filename and the recorded Blob MIME type', () => {
  const audio = new Blob(['audio bytes'], { type: WEBM_OPUS_MIME_TYPE })
  const file = transcriptionFormData(audio).get('file') as File
  assert.equal(file.name, 'recording.webm')
  assert.equal(file.type, WEBM_OPUS_MIME_TYPE)
})

test('does not mislabel an unexpected recorded format as WebM', () => {
  assert.throws(() => audioFileName('audio/ogg;codecs=opus'), /Unsupported recorded audio format/)
})
