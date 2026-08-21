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

test('thread history renders persisted subthread titles for subthread tools', () => {
  assert.match(source, /subthreads: SubthreadReference\[\]/)
  assert.match(source, /const subthreadById = new Map\(subthreads\.map/)
  assert.match(source, /const subthreadByForkRecordId = new Map\(subthreads\.map/)
  assert.match(source, /subthreadByForkRecordId\.get\(record\.id\)/)
  assert.match(source, /function SubthreadToolEntry/)
  assert.match(source, /item\.subthread\?\.title/)
  assert.match(source, /to=\{`\/threads\/\$\{item\.subthread\.id\}`\}/)
})

test('thread detail reserves a bounded scrollable history viewport', () => {
  assert.match(source, /<main className="flex h-full min-h-0 flex-col">/)
  assert.match(source, /max-h-\[35svh\] shrink-0 overflow-y-auto border-b p-4/)
  assert.match(source, /<div className="min-h-0 flex-1"><ThreadHistoryRecordsView threadId=\{thread\.id\} \/><\/div>/)
  assert.match(source, /return <div className="min-h-0 flex-1"><ConversationFeed/)
})
