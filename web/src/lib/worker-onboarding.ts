export type Platform = { id: string; label: string }
export type Release = { version: string; release_url: string; platforms: Platform[]; android?: { version: string; release_url: string } }
export type Device = { id: string; label: string; created_at: number; last_seen_at?: number | null; status: "online" | "offline" | "unknown"; owner_user_id?: string; access?: "owner" | "shared"; version?: string | null; can_upgrade?: boolean; upgrade_target?: string | null; upgrade?: { version: string; status: "queued" | "installing" | "completed" | "failed"; error: string | null } | null }
export type Pairing = { id: string; user_code: string; hostname: string; platform: string; version: string; expires_at: number; status: "pending" | "approving" | "approved" | "expired" | "cancelled"; worker_id: string }
export type Capability = { status: "ready" | "failed" | "not_checked" | "missing_dependency" | "unsupported"; detail: string }
export type Check = { id: string; worker_id: string; status: "queued" | "delivered" | "completed" | "timed_out"; created_at: number; completed_at: number | null; result: { shell?: Capability; browser?: Capability; desktop?: Capability; version?: string; platform?: string; arch?: string } | null }

export function normalizeCode(value: string) { return value.trim().replace(/[-\s]/g, "").toUpperCase().match(/.{1,4}/g)?.join("-") ?? "" }
export function validCode(value: string) { return /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(normalizeCode(value)) }
// COMPATIBILITY: frontend fixtures predating sharing omit access. Remove this
// fallback once all typed fixtures declare access; production rows always include it.
export function ownedDevice(device: Device) { return device.access === "owner" || device.access === undefined }
export function deviceStatus(device: Device) { return !ownedDevice(device) || device.status === "unknown" ? device.status : device.last_seen_at == null ? "waiting" : device.status }
export function checkReady(check: Check | null | undefined, device: Device | undefined) {
  return Boolean(device && ownedDevice(device) && device.status === "online" && check?.worker_id === device.id && check.status === "completed" && check.result?.shell?.status === "ready")
}
export function assetName(platform: string) { return `cybion-worker-${platform}.${platform.startsWith("windows") ? "zip" : "tar.gz"}` }
export function downloadUrl(release: Release, platform: string, origin: string) {
  if (!release.platforms.some((item) => item.id === platform) || !/^v\d+\.\d+\.\d+$/.test(release.version)) throw new Error("Invalid Worker release")
  return `${origin.replace(/\/+$/, "")}/worker-release/${release.version}/${assetName(platform)}`
}
export function runCommand(platform: string) { return platform.startsWith("windows") ? ".\\cybion-worker.exe run --background" : "./cybion-worker run --background" }
export function installCommand(release: Release, platform: string, origin: string) {
  const url = downloadUrl(release, platform, origin)
  const asset = assetName(platform)
  const folder = `cybion-worker-${platform}`
  if (platform.startsWith("windows")) return `$ErrorActionPreference = 'Stop'\nInvoke-WebRequest '${url}' -OutFile '${asset}'\nInvoke-WebRequest '${url}.sha256' -OutFile '${asset}.sha256'\n$expected = ((Get-Content '${asset}.sha256') -split '\\s+')[0]\nif ((Get-FileHash '${asset}' -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }\nExpand-Archive '${asset}' -DestinationPath '.'\n& '.\\${folder}\\cybion-worker.exe' run --background`
  const checksum = platform.startsWith("macos") ? "shasum -a 256 -c" : "sha256sum -c"
  return `curl -fL --retry 2 '${url}' -o '${asset}' &&\ncurl -fL --retry 2 '${url}.sha256' -o '${asset}.sha256' &&\n${checksum} '${asset}.sha256' &&\ntar -xzf '${asset}' &&\n'./${folder}/cybion-worker' run --background`
}

export function upgradeTargetVersion(device: Device, release: Release | undefined) {
  return device.upgrade_target ?? release?.version ?? null
}
export function upgradeAvailable(device: Device, release: Release | undefined) {
  const recommendation = upgradeTargetVersion(device, release)
  if (!ownedDevice(device) || !recommendation || !device.can_upgrade || device.status !== "online" || ["queued", "installing"].includes(device.upgrade?.status ?? "")) return false
  const parse = (v: string) => /^v?\d+\.\d+\.\d+$/.test(v) ? v.replace(/^v/, "").split(".").map(Number) : null
  const current = parse(device.version ?? "")
  const target = parse(recommendation)
  if (!current || !target) return false
  for (let i = 0; i < 3; i++) {
    if (current[i] !== target[i]) return current[i] < target[i]
  }
  return false
}
