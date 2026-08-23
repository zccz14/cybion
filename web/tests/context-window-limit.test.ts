import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('settings expose an optional proactive context compaction threshold', () => {
  assert.match(source, /context_window_limit: number \| null/)
  assert.match(source, /id="context-window-limit"/)
  assert.match(source, /context_window_limit: contextWindowLimit\.trim\(\) \? Number\(contextWindowLimit\) : null/)
  assert.match(source, /contextWindowLimitHint/)
})

test('thread detail identifies its persisted context compaction threshold', () => {
  assert.match(source, /context_window_limit: number \| null/)
  assert.match(source, /contextWindowLimitLabel\(t, thread\.context_window_limit\)/)
})
