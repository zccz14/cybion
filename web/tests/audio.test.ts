import assert from 'node:assert/strict'
import test from 'node:test'
import { audioFileName, preferredAudioMimeType } from '../src/audio.ts'

test('prefers a supported WebM/Opus recorder format', () => {
  assert.equal(
    preferredAudioMimeType((mimeType) => mimeType === 'audio/webm; codecs=opus'),
    'audio/webm; codecs=opus',
  )
})

test('uses plain WebM when the Opus-specific MIME type is unavailable', () => {
  assert.equal(
    preferredAudioMimeType((mimeType) => mimeType === 'audio/webm'),
    'audio/webm',
  )
})

test('lets MediaRecorder select its default format when no preferred type is supported', () => {
  assert.equal(preferredAudioMimeType(() => false), undefined)
})

test('keeps uploaded filename extensions aligned with recorded audio MIME types', () => {
  assert.equal(audioFileName('audio/webm; codecs=opus'), 'recording.webm')
  assert.equal(audioFileName('audio/ogg; codecs=opus'), 'recording.ogg')
  assert.equal(audioFileName('audio/mp4'), 'recording.m4a')
})
