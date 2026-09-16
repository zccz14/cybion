import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/components/admin-users.tsx", import.meta.url), "utf8")

test("administrator users page keeps identity and per-user operational metrics together", () => {
  assert.match(source, /LinkitUserInfo userId=\{user\.user_id\}/)
  for (const field of ["requests", "total_tokens", "cache_hit_rate", "history_records", "threads", "in_flight", "sqlite_bytes", "worker_sent_bytes", "worker_received_bytes", "upstream_sent_bytes", "upstream_received_bytes"]) {
    assert.match(source, new RegExp(field))
  }
  assert.match(source, /refetchInterval: 5000/)
  assert.match(source, /仅管理员可查看用户列表。/)
})
