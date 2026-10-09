import assert from "node:assert/strict"
import test from "node:test"
import { formatInterval, machineStatus, type Machine } from "../src/lib/ultimate-machines.ts"

const base: Machine = {
  id: "m1",
  name: "磁盘检查",
  worker_id: "w1",
  worker_label: "Linux US",
  command: "test -f /tmp/ok",
  interval_seconds: 600,
  thread_id: "t1",
  thread_title: "终极机器 · 磁盘检查",
  enabled: true,
  last_run_at: 1,
  last_exit: 0,
  created_at: 0,
}

test("machine status reflects enablement and the latest result", () => {
  assert.equal(machineStatus({ ...base, enabled: false, last_run_at: 1, last_exit: 0 }), "paused")
  assert.equal(machineStatus({ ...base, last_run_at: null }), "waiting")
  assert.equal(machineStatus({ ...base, last_exit: 0 }), "ok")
  assert.equal(machineStatus({ ...base, last_exit: 3 }), "failed")
  assert.equal(machineStatus({ ...base, last_exit: -1 }), "failed")
  assert.equal(machineStatus({ ...base, last_exit: null }), "failed")
})

test("interval formatting scales to days, hours, minutes and seconds", () => {
  assert.equal(formatInterval("zh", 10), "10 秒")
  assert.equal(formatInterval("zh", 600), "10 分钟")
  assert.equal(formatInterval("zh", 7200), "2 小时")
  assert.equal(formatInterval("zh", 86400), "1 天")
  assert.equal(formatInterval("en", 600), "10 min")
  assert.equal(formatInterval("zh", 90), "90 秒")
})
