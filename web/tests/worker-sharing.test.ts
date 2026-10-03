import assert from "node:assert/strict"
import test from "node:test"
import { recipientError } from "../src/lib/worker-sharing.ts"
import { ownedDevice, deviceStatus, checkReady, upgradeAvailable, type Device } from "../src/lib/worker-onboarding.ts"
import { ownWorkerCall, type WorkerCallAudit } from "../src/lib/worker-audit.ts"

test("recipient selection rejects only the signed-in identity", () => {
  assert.equal(recipientError("", "owner"), null)
  assert.equal(recipientError("uid-with.Exact_Case", "owner"), null)
  assert.equal(recipientError("owner", "owner"), "self")
  assert.equal(recipientError("owner", undefined), null)
})

test("shared cached discovery never implies first connection, verified health or upgrade permission", () => {
  const device: Device = { id: "shared", label: "Shared", created_at: 1, access: "shared", owner_user_id: "other", status: "unknown" }
  assert.equal(ownedDevice(device), false)
  assert.equal(deviceStatus(device), "unknown")
  assert.equal(deviceStatus({ ...device, status: "offline" }), "offline")
  const online = { ...device, status: "online" as const, version: "0.2.0", can_upgrade: true }
  assert.equal(checkReady({ id: "check", worker_id: "shared", status: "completed", created_at: 1, completed_at: 2, result: { shell: { status: "ready", detail: "shell_ok" } } }, online), false)
  assert.equal(upgradeAvailable(online, { version: "v0.2.1", release_url: "", platforms: [] }), false)
  assert.equal(ownedDevice({ ...device, access: "owner" }), true)
  assert.equal(ownedDevice({ ...device, access: undefined }), true)
})

test("Thread links require a positively matched current caller, never a session ID or missing identity", () => {
  const item = { caller_user_id: "stable-owner" } as WorkerCallAudit
  assert.equal(ownWorkerCall(item, "stable-owner"), true)
  assert.equal(ownWorkerCall(item, "session-owner"), false)
  assert.equal(ownWorkerCall(item, "recipient"), false)
  assert.equal(ownWorkerCall(item, undefined), false)
})
