import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('threads use an explicit active index and unpolled terminal pagination', () => {
  assert.match(source, /api<ThreadIndex>\('\/api\/threads\?status=active', token\), refetchInterval: 1000/)
  assert.match(source, /const terminalUrl = `\/api\/threads\?status=\$\{terminalStatus\}&page=\$\{terminalPage\}&page_size=\$\{terminalPageSize\}`/)
  assert.match(source, /terminalThreads/)
  assert.doesNotMatch(source, /api<ThreadIndex>\('\/api\/threads', token\), refetchInterval: 1000/)
})
