import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('thread history renders persisted Responses output_text content as assistant text', () => {
  assert.match(source, /function protocolMessageText/)
  assert.match(source, /value\.type === 'output_text' && typeof value\.text === 'string'/)
  assert.match(source, /const content = protocolMessageText\(record\.payload\)/)
})

test('thread history preserves legacy string message content', () => {
  assert.match(source, /if \(typeof content === 'string'\) return content/)
})
