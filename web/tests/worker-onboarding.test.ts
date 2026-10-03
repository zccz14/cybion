import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { normalizeCode, validCode, deviceStatus, checkReady, downloadUrl, installCommand, type Device, type Check, type Release } from "../src/lib/worker-onboarding.ts"
const release: Release = JSON.parse(readFileSync(new URL("../../worker-release.json", import.meta.url), "utf8"))
const origin = "https://cybion.ntnl.io"
test("release manifest drives all five platform downloads and checksum commands", () => {
  assert.equal(release.platforms.length, 5)
  for (const p of release.platforms) {
    assert.ok(downloadUrl(release, p.id, origin).startsWith(`${origin}/worker-release/${release.version}/`))
    assert.match(installCommand(release, p.id, origin), /sha256|SHA256/)
    if (p.id.startsWith("windows")) assert.ok(downloadUrl(release, p.id, origin).endsWith(".zip"))
    else assert.match(installCommand(release, p.id, origin), /&&\ntar/)
  }
  assert.throws(() => downloadUrl(release, "unknown", origin))
})
test("normalize pairing codes without accepting partial or non-hex values", () => {
  assert.equal(normalizeCode("abcd 1234-ef56"), "ABCD-1234-EF56")
  assert.ok(validCode("abcd1234ef56")); assert.ok(!validCode("1234")); assert.ok(!validCode("ZZZZ-1234-EF56"))
})
test("first connection and completed round trip are distinct from heartbeat online", () => {
  const device: Device = { id: "target", label: "Mac", created_at: 1, status: "offline" }
  assert.equal(deviceStatus(device), "waiting")
  device.last_seen_at = 2; assert.equal(deviceStatus(device), "offline")
  device.status = "online"; assert.equal(checkReady(null, device), false)
  const check: Check = { id: "test", worker_id: "other", status: "completed", created_at: 1, completed_at: 2, result: { shell: { status: "ready", detail: "shell_ok" } } }
  assert.equal(checkReady(check, device), false)
  check.worker_id = device.id; assert.equal(checkReady(check, device), true)
  check.status = "timed_out"; assert.equal(checkReady(check, device), false)
})
test("the guide is bilingual, requires explicit consent, and does not persist credentials", () => {
  const source = readFileSync(new URL("../src/components/worker-connections.tsx", import.meta.url), "utf8")
  assert.match(source, /checked=\{confirmed\}/)
  assert.match(source, /disabled=\{!confirmed/)
  assert.match(source, /await navigator.clipboard.writeText/)
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.setItem/)
  assert.match(source, /target === "remote"/)
  assert.match(source, /automatic && device.status === "online"/)
})
test("late approval updates only the code actually approved, not the currently open guide", () => {
  const source = readFileSync(new URL("../src/components/worker-connections.tsx", import.meta.url), "utf8")
  assert.match(source, /client\.setQueryData\(\["worker-pairing", sessionId, value\.user_code\], value\)/)
})

test("remote upgrade requires capability, a newer recommendation, an online device and no pending upgrade", async () => {
  const { upgradeAvailable } = await import("../src/lib/worker-onboarding.ts")
  const device = { id: "device", label: "Device", created_at: 0, status: "online" as const, version: "0.2.0", can_upgrade: true }
  const release = { version: "v0.2.1", release_url: "", platforms: [] }
  assert.equal(upgradeAvailable(device, release), true)
  assert.equal(upgradeAvailable({ ...device, can_upgrade: false }, release), false)
  assert.equal(upgradeAvailable({ ...device, status: "offline" }, release), false)
  assert.equal(upgradeAvailable(device, { ...release, version: "v0.2.0" }), false)
  assert.equal(upgradeAvailable(device, { ...release, version: "v0.1.99" }), false)
  assert.equal(upgradeAvailable({ ...device, upgrade: { version: "v0.2.1", status: "installing", error: null } }, release), false)
})

test("device-specific upgrade targets follow the android app release", async () => {
  const { upgradeAvailable, upgradeTargetVersion } = await import("../src/lib/worker-onboarding.ts")
  const android = release.android
  assert.ok(android, "worker-release.json declares the android app release")
  assert.match(android.version, /^v\d+\.\d+\.\d+$/)
  assert.ok(android.release_url.includes("zccz14/cybion-worker-for-android"))
  assert.ok(android.release_url.endsWith(`/releases/tag/${android.version}`))
  const device: Device = { id: "android", label: "Phone", created_at: 0, status: "online", version: "0.1.6", can_upgrade: true, upgrade_target: android.version }
  assert.equal(upgradeTargetVersion(device, release), android.version)
  assert.equal(upgradeAvailable(device, release), true)
  assert.equal(upgradeAvailable({ ...device, version: android.version.replace(/^v/, "") }, release), false)
  assert.equal(upgradeTargetVersion({ ...device, upgrade_target: null }, release), release.version)
  assert.equal(upgradeAvailable({ ...device, upgrade_target: null, version: "0.1.0" }, release), true)
  assert.equal(upgradeAvailable({ ...device, upgrade_target: null, version: "0.1.0" }, undefined), false)
})

test("the upgrade button shows the device-specific target version", () => {
  const source = readFileSync(new URL("../src/components/worker-connections.tsx", import.meta.url), "utf8")
  assert.match(source, /upgradeTargetVersion\(device, release\.data\)/)
})
