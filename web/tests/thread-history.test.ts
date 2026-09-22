import assert from "node:assert/strict"
import test from "node:test"
import { formatThreadProcessDuration, groupThreadHistory, pollThreadHistory, threadHistoryRecordKey, type HistoryRecord } from "../src/lib/thread-history.ts"
import { pendingResponseRecords, type ThreadResponseView } from "../src/lib/thread-response.ts"

function record(id: number, kind: HistoryRecord["kind"], payload: unknown = null, created_at = id): HistoryRecord {
  return { id, thread_id: "thread-a", kind, payload, created_at }
}

test("empty histories and histories containing only standalone messages do not create process groups", () => {
  assert.deepEqual(groupThreadHistory([]), [])
  const records = [
    record(1, "input", { role: "user", content: "Hello" }),
    record(2, "response_output", { type: "message", role: "assistant", content: [] }),
    record(3, "activity", { role: "system", content: "Request failed: error" }),
    record(4, "activity", { type: "thread_control", action: "continue" }),
  ]
  const entries = groupThreadHistory(records)
  assert.deepEqual(entries.map((entry) => entry.type), ["message", "message", "message", "message"])
  entries.forEach((entry, index) => {
    assert.equal(entry.type, "message")
    if (entry.type === "message") assert.equal(entry.record, records[index])
  })
})

test("all other record types form adjacent groups, including singletons at both ends", () => {
  const records = [
    record(1, "checkpoint"),
    record(2, "input"),
    record(3, "response_output", { type: "reasoning" }),
    record(4, "response_output", { type: "function_call" }),
    record(5, "tool_output", { type: "function_call_output" }),
    record(6, "response_output", { type: "web_search_call" }),
    record(7, "response_output", { type: "image_generation_call", result: "image" }),
    record(8, "response_output", { type: "future_protocol_type" }),
    record(9, "checkpoint"),
    record(10, "activity"),
    record(11, "tool_output"),
    record(12, "response_output", { type: "message" }),
    record(13, "response_output", { type: "reasoning" }),
  ]
  const entries = groupThreadHistory(records)
  assert.deepEqual(entries.map((entry) => entry.type === "process" ? entry.records.map((item) => item.id) : entry.record.id), [
    [1], 2, [3, 4, 5, 6, 7, 8, 9], 10, [11], 12, [13],
  ])
})

test("only response message items are standalone; unexpected payload shapes remain inspectable in groups", () => {
  const records = [null, undefined, "message", 1, [], {}, { role: "assistant" }].map((payload, i) => record(i, "response_output", payload))
  records.push(record(8, "tool_output", { type: "message" }))
  const entries = groupThreadHistory(records)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].type, "process")
  if (entries[0].type === "process") assert.deepEqual(entries[0].records, records)
})

test("grouping preserves exact record order and references without mutating input data", () => {
  const records = Object.freeze([
    Object.freeze(record(5, "tool_output", Object.freeze({ output: "a" }), 500)),
    Object.freeze(record(3, "checkpoint", Object.freeze({ summary: "b" }), 100)),
    Object.freeze(record(7, "activity", Object.freeze({ content: "c" }), 200)),
    Object.freeze(record(6, "tool_output", Object.freeze({ output: "d" }), 300)),
  ])
  const snapshot = JSON.stringify(records)
  const entries = groupThreadHistory(records)
  const flattened = entries.flatMap((entry) => entry.type === "process" ? entry.records : [entry.record])
  flattened.forEach((item, index) => assert.equal(item, records[index]))
  assert.equal(JSON.stringify(records), snapshot)
  assert.deepEqual(groupThreadHistory(records), entries)
})

test("elapsed time uses minimum and maximum timestamps, not array endpoints or adjacent standalone messages", () => {
  const entries = groupThreadHistory([
    record(1, "input", null, 0),
    record(2, "tool_output", null, 500),
    record(3, "checkpoint", null, 100),
    record(4, "tool_output", null, 3765),
    record(5, "response_output", { type: "reasoning" }, 800),
    record(6, "activity", null, 99999),
  ])
  const group = entries[1]
  assert.equal(group.type, "process")
  if (group.type !== "process") return
  assert.equal(group.startedAt, 100)
  assert.equal(group.finishedAt, 3765)
  assert.equal(formatThreadProcessDuration(group.finishedAt - group.startedAt, "zh"), "运行了 01 小时 01 分钟 05 秒")
})

test("singleton and same-timestamp groups have zero elapsed time", () => {
  for (const records of [[record(1, "tool_output", null, 10)], [record(1, "tool_output", null, 10), record(2, "checkpoint", null, 10)]]) {
    const [group] = groupThreadHistory(records)
    assert.equal(group.type, "process")
    if (group.type === "process") assert.equal(group.finishedAt - group.startedAt, 0)
  }
})

test("duration labels pad all units, carry correctly, and never wrap hours at 24 or 100", () => {
  for (const [seconds, zh, en] of [
    [0, "00 小时 00 分钟 00 秒", "00h 00m 00s"],
    [59, "00 小时 00 分钟 59 秒", "00h 00m 59s"],
    [60, "00 小时 01 分钟 00 秒", "00h 01m 00s"],
    [3599, "00 小时 59 分钟 59 秒", "00h 59m 59s"],
    [3600, "01 小时 00 分钟 00 秒", "01h 00m 00s"],
    [86400, "24 小时 00 分钟 00 秒", "24h 00m 00s"],
    [360001, "100 小时 00 分钟 01 秒", "100h 00m 01s"],
    [1.9, "00 小时 00 分钟 01 秒", "00h 00m 01s"],
  ] as const) {
    assert.equal(formatThreadProcessDuration(seconds, "zh"), `运行了 ${zh}`)
    assert.equal(formatThreadProcessDuration(seconds, "en"), `Ran for ${en}`)
  }
})

test("group keys survive polling, appends, and preview-to-durable row ID changes", () => {
  const preview = record(-1, "response_output", { id: "rs_1", type: "reasoning", summary: [] }, 100)
  const initial = groupThreadHistory([preview])[0]
  const polled = groupThreadHistory([structuredClone(preview)])[0]
  const committed = groupThreadHistory([{ ...preview, id: 10, created_at: 105 }, record(11, "tool_output", null, 135)])[0]
  assert.equal(initial.key, polled.key)
  assert.equal(initial.key, committed.key)
  assert.notEqual(initial.key, groupThreadHistory([{ ...preview, payload: { id: "rs_2", type: "reasoning" } }])[0].key)
  assert.notEqual(threadHistoryRecordKey(preview), threadHistoryRecordKey({ ...preview, thread_id: "thread-b" }))
  assert.notEqual(threadHistoryRecordKey(record(-1, "response_output", null, 100)), threadHistoryRecordKey(record(-1, "response_output", null, 200)))
})

test("persisted and pending process items join one group and the existing response handoff removes duplicates", () => {
  const reasoning = { id: "rs_1", type: "reasoning", summary: [] }
  const call = { id: "fc_1", type: "function_call", name: "bash", arguments: "{}" }
  const view: ThreadResponseView = {
    audit_id: 1, input_record_id: 1, started_at: 100, status: "in_flight",
    response: {
      response_id: "r", completed: false, server_model: "model", model_verifications: [], safety_buffering: null, rate_limits: [], usage: null, error: null,
      output: [{ item: reasoning, done: true, record_id: 2 }, { item: call, done: false, record_id: null }],
    },
  }
  const history = [record(1, "input"), record(2, "response_output", reasoning, 105)]
  const entries = groupThreadHistory([...history, ...pendingResponseRecords(view, history, "thread-a")])
  assert.equal(entries.length, 2)
  const group = entries[1]
  assert.equal(group.type, "process")
  if (group.type !== "process") return
  assert.deepEqual(group.records.map((item) => item.payload), [reasoning, call])
  history.push(record(3, "response_output", call, 120))
  view.response.output[1].record_id = 3
  const committed = groupThreadHistory([...history, ...pendingResponseRecords(view, history, "thread-a")])[1]
  assert.equal(committed.key, group.key)
  if (committed.type === "process") {
    assert.equal(committed.records.length, 2)
    assert.equal(committed.finishedAt - committed.startedAt, 15)
  }
})

test("incremental polling fetches only records after the newest loaded one and appends them", async () => {
  const requests: number[] = []
  const fetchAfter = async (after: number) => {
    requests.push(after)
    return after === 0 ? [record(1, "input"), record(5, "activity")] : [record(after + 1, "tool_output")]
  }
  const initial = await pollThreadHistory(undefined, fetchAfter)
  const appended = await pollThreadHistory(initial, fetchAfter)
  assert.deepEqual(requests, [0, 5])
  assert.deepEqual(appended.map((item) => item.id), [1, 5, 6])
  assert.deepEqual(initial.map((item) => item.id), [1, 5])
})
