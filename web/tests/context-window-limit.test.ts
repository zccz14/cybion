import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('the UI does not expose context-window overrides', () => {
  assert.doesNotMatch(source, /context_window_limit/)
  assert.doesNotMatch(source, /context-window-limit/)
  assert.doesNotMatch(source, /contextWindowLimit/)
})
