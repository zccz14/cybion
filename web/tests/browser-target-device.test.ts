import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('browser control selects controller or online target devices and forwards the device query', () => {
  assert.match(source, /effectiveTargetDevice/)
  assert.match(source, /\/api\/peers/)
  assert.match(source, /target_device=/)
  assert.match(source, /target_name/)
})

test('browser control keeps remote session actions scoped to their selected target', () => {
  assert.match(source, /sessions\/\$\{selected\.id\}\/stream\$\{targetQuery\}/)
  assert.match(source, /sessions\/\$\{selected\.id\}\/input\$\{targetQuery\}/)
  assert.match(source, /sessions\/\$\{selected\.id\}\/approve\$\{targetQuery\}/)
})
