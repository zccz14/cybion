import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')

test('thread history renders persisted Responses output_text content as assistant text', () => {
  assert.match(source, /function protocolMessageText/)
  assert.match(source, /value\.type === 'output_text' && typeof value\.text === 'string'/)
  assert.match(source, /content: protocolMessageText\(record\.payload\)/)
})

test('thread history preserves legacy string message content', () => {
  assert.match(source, /if \(typeof content === 'string'\) return content/)
})

test('thread history preserves record order and record granularity', () => {
  const classifier = source.match(/function threadHistoryItems[\s\S]*?\n}\n\nfunction ThreadHistoryRecordsView/)?.[0] ?? ''
  assert.match(classifier, /for \(const record of records\)/)
  assert.match(classifier, /id: String\(record\.id\)/)
  assert.match(classifier, /items\.push\(\{ kind: 'tool', id: String\(record\.id\)/)
  assert.match(classifier, /items\.push\(\{ kind: 'fallback', id: String\(record\.id\)/)
  assert.doesNotMatch(classifier, /Object\.assign\(tool/)
})

test('thread history preserves malformed records as concise unavailable details', () => {
  const classifier = source.match(/function threadHistoryItems[\s\S]*?\n}\n\nfunction ThreadHistoryRecordsView/)?.[0] ?? ''
  assert.match(classifier, /items\.push\(\{ kind: 'fallback', id: String\(record\.id\), label: record\.kind === 'checkpoint' \? 'checkpoint' : type \|\| record\.kind \}\)/)
  assert.match(source, /item\.kind === 'fallback'/)
  assert.match(source, /t\('detailsUnavailable'\)/)
})

test('thread history classifies skill tools without rendering resource content', () => {
  assert.match(source, /item\.name === 'load_skill' \|\| item\.name === 'read_skill_resource'/)
  assert.match(source, /const resourcePath = stringValue\(item\.arguments\.relative_path\)\.replace/)
  assert.match(source, /const parameters = knownSkillTool \? ''/)
  assert.match(source, /skillLoading: 'Loading skill'/)
  assert.match(source, /resourceRead: 'Resource read'/)
  assert.match(source, /skillLoading: '正在加载技能'/)
  assert.match(source, /resourceRead: '已读取资源'/)
})

test('thread history summarizes terminal handoffs and links referenced child threads', () => {
  assert.match(source, /outputPayload\?\.type === 'subthread_handoff'/)
  assert.match(source, /function SubthreadHandoffEntry/)
  assert.match(source, /goalStateLabel\(language, item\.terminalState as GoalState\)/)
  assert.match(source, /item\.subthread\.model/)
  assert.match(source, /to=\{`\/threads\/\$\{item\.subthread\.id\}`\}/)
})

test('thread history only uses stored reasoning summaries and never encrypted reasoning content', () => {
  const classifier = source.match(/function safeReasoningSummary[\s\S]*?\n}\n\nfunction threadHistoryItems/)?.[0] ?? ''
  assert.match(classifier, /const summary = payload\.summary/)
  assert.doesNotMatch(classifier, /encrypted_content/)
  assert.match(source, /reasoningSummaryUnavailable: 'Reasoning summary unavailable'/)
  assert.match(source, /reasoningWithheld: 'Reasoning withheld'/)
  assert.match(source, /reasoningSummaryUnavailable: '推理摘要不可用'/)
  assert.match(source, /reasoningWithheld: '推理内容已保留'/)
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

test('thread history polls every mounted thread without depending on active state', () => {
  const view = source.match(/function ThreadHistoryRecordsView[\s\S]*?\n}\n\nfunction ConversationFeed/)?.[0] ?? ''
  assert.match(view, /void poll\(true\)/)
  assert.match(view, /window\.setInterval\(\(\) => \{ void poll\(\) \}, 1000\)/)
  assert.match(view, /new URLSearchParams\(\{ after_id: String\(cursorRef\.current\) \}\)/)
  assert.doesNotMatch(view, /if \(!active\) return/)
})

test('thread history serializes polling and ignores stale or unmounted responses', () => {
  const view = source.match(/function ThreadHistoryRecordsView[\s\S]*?\n}\n\nfunction ConversationFeed/)?.[0] ?? ''
  assert.match(view, /let polling = false/)
  assert.match(view, /if \(polling\) return/)
  assert.match(view, /const current = \(\) => !cancelled && generationRef\.current === generation/)
  assert.match(view, /if \(!current\(\)\) return/)
  assert.match(view, /return \(\) => \{ cancelled = true; window\.clearInterval\(interval\) \}/)
})

test('thread history resets switched threads and deduplicates later records', () => {
  assert.match(source, /function mergeThreadHistoryRecords/)
  assert.match(source, /next\.filter\(\(record\) => !known\.has\(record\.id\)\)/)
  const view = source.match(/function ThreadHistoryRecordsView[\s\S]*?\n}\n\nfunction ConversationFeed/)?.[0] ?? ''
  assert.match(view, /cursorRef\.current = 0/)
  assert.match(view, /setRecords\(\[\]\); setSubthreads\(\[\]\); setCursor\(0\)/)
  assert.match(view, /applyPage\(await request\(params\), initial\)/)
  assert.match(view, /generation !== generationRef\.current/)
})
