import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const notifications = readFileSync(new URL("../src/components/linkit-notifications.tsx", import.meta.url), "utf8")
test("the Linkit connection is ensured silently on load while the switch only controls notifications", () => {
  assert.match(main, /<LinkitNotifications language=\{language\} sessionId=/)
  assert.match(main, /function LinkitAutoEnsure/)
  assert.match(main, /api<unknown>\(sdk, "\/api\/integrations\/linkit", \{ method: "POST" \}\)/)
  assert.match(main, /queryKey: \["linkit-notifications"\]/)
  assert.doesNotMatch(main, /integrations\.data\.linkit_configured/)
  assert.match(notifications, /method: "PUT"/)
  assert.match(notifications, /Switch/)
  assert.match(notifications, /last_error/)
  assert.match(notifications, /last_success_at/)
  assert.match(notifications, /\/api\/integrations\/linkit\/test/)
  assert.match(notifications, /not device push or read status/)
  assert.match(notifications, /不代表设备推送或已读/)
  assert.doesNotMatch(notifications, /linkit\/refresh/)
  assert.doesNotMatch(notifications, /\/bot\/v1\/messages/)
})
