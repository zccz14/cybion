import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('goals use server-side status, keyword, model, and page queries', () => {
  assert.match(source, /api<ThreadIndex>\('\/api\/threads\?status=active', token\), refetchInterval: liveActive \? 1000 : false/)
  assert.match(source, /new URLSearchParams\(\{ status, page: String\(page\), page_size: String\(pageSize\) \}\)/)
  assert.match(source, /query\.set\('query', keyword\)/)
  assert.match(source, /query\.set\('model', model\)/)
  assert.match(source, /status: 'active'/)
  assert.match(source, /<SelectItem value="all">\{statusLabel\('all'\)\}<\/SelectItem>/)
  assert.match(source, /threadSearch/)
  assert.match(source, /threadModelFilter/)
  assert.match(source, /threadNoMatches/)
  assert.match(source, /liveActive = status === 'active' && !keyword && !model/)
  assert.doesNotMatch(source, /subthreads\.filter\(/)
  assert.doesNotMatch(source, /terminalUrl =/)
  assert.doesNotMatch(source, /api<ThreadIndex>\('\/api\/threads', token\), refetchInterval: 1000/)
})
