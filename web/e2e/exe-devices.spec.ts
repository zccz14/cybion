import { test, expect, type Page } from "@playwright/test"

const ADDRESS = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9"
const DEVICES = [
  { worker_id: "exe-1", label: "客厅 Mac mini", address: "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse", status: "online", last_seen_at: 1_770_000_000, platform: "macos", version: "0.6.3" },
  { worker_id: "exe-2", label: "机房 Linux", address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", status: "offline", last_seen_at: null, platform: "linux", version: "0.6.3" },
  { worker_id: "exe-3", label: "旧笔记本", address: "9xQeWvG816bUx9EPf7r1b1X5jEzj8m4j8m4j8m4j8m4j", status: "offline", last_seen_at: 1_760_000_000, platform: "windows", version: "0.6.2" },
]
const WORKER = { id: "worker-1", label: "MacMini", owner_user_id: "stable-owner", access: "owner", kind: "worker", status: "online", created_at: 1_770_000_000, last_seen_at: 1_770_000_000, version: "0.6.32", can_upgrade: false, upgrade_target: null, upgrade: null }

async function fixture(page: Page) {
  const requests: { path: string; method: string; body: string | null }[] = []
  let devices = [...DEVICES]
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ path, method: request.method(), body: request.postData() })
    if (path === "/api/me") return route.fulfill({ json: { user_id: "stable-owner" } })
    if (path === "/api/workers") return route.fulfill({ json: [WORKER] })
    if (path === "/api/worker-release") return route.fulfill({ json: { version: "v0.6.32", release_url: "", platforms: [] } })
    if (path === "/api/exe") return route.fulfill({ json: { address: ADDRESS, created_at: 1_770_000_000, devices } })
    if (path === "/api/exe/devices" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}")
      const device = { worker_id: `exe-${devices.length + 1}`, label: body.label ?? "eXe 设备", address: body.address, status: "online", last_seen_at: 1_770_000_100 }
      devices = [device, ...devices]
      return route.fulfill({ json: device })
    }
    if (path.startsWith("/api/workers/") && request.method() === "DELETE") {
      const id = path.split("/").at(-1)!
      devices = devices.filter((device) => device.worker_id !== id)
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ status: 403, json: { error: `Unexpected fixture request: ${path}` } })
  })
  return { requests }
}

test("shows the account address, the trust command and every connected eXe device", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 })
  await fixture(page)
  await page.goto("/e2e/exe-devices.html#/workers")
  const card = page.getByRole("region", { name: "eXe 设备" })
  await expect(card.getByText(ADDRESS, { exact: true }).first()).toBeVisible()
  await expect(card.getByText(`exe trust ${ADDRESS}`, { exact: true })).toBeVisible()
  await expect(card.getByText("客厅 Mac mini")).toBeVisible()
  await expect(card.getByText("在线", { exact: true })).toHaveCount(1)
  await expect(card.getByText("离线", { exact: true })).toHaveCount(2)
  await expect(card.getByText("从未上线", { exact: false })).toBeVisible()
  // An eXe device is not a Worker: no upgrade, check or sharing controls.
  await expect(card.getByRole("button", { name: "升级 Worker" })).toHaveCount(0)
  await expect(card.getByRole("button", { name: "共享访问" })).toHaveCount(0)
  await page.screenshot({ path: "test-results/exe-devices-desktop-zh.png", fullPage: true })
})

test("connects a device by address, refuses a malformed one, and removes it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 })
  const state = await fixture(page)
  await page.goto("/e2e/exe-devices.html#/workers")
  const card = page.getByRole("region", { name: "eXe 设备" })
  const input = card.getByLabel("设备地址")
  const connect = card.getByRole("button", { name: "接入", exact: true })
  await expect(connect).toBeDisabled()
  await input.fill("not-an-address")
  await expect(connect).toBeDisabled()
  await expect(card.getByText("设备地址应为 32 字节公钥的 base58 形式", { exact: false })).toBeVisible()
  const fresh = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
  await input.fill(fresh)
  await card.getByLabel("设备名称 (可选)").fill("新手机")
  await connect.click()
  await expect(card.getByText("新手机")).toBeVisible()
  const posted = state.requests.find((request) => request.path === "/api/exe/devices" && request.method === "POST")
  expect(JSON.parse(posted!.body!)).toEqual({ address: fresh, label: "新手机" })
  await page.screenshot({ path: "test-results/exe-devices-connected.png", fullPage: true })

  page.on("dialog", (dialog) => void dialog.accept())
  await card.getByRole("button", { name: "移除" }).first().click()
  await expect(card.getByText("新手机")).toHaveCount(0)
  expect(state.requests.some((request) => request.path === "/api/workers/exe-4" && request.method === "DELETE")).toBe(true)
})

test("stays readable in English, dark mode and a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await fixture(page)
  await page.goto("/e2e/exe-devices.html#/workers")
  await page.getByRole("button", { name: "Language", exact: true }).click()
  await page.getByRole("button", { name: "Theme", exact: true }).click()
  const card = page.getByRole("region", { name: "eXe devices" })
  await expect(card.getByText("An eXe device runs shell commands only", { exact: false })).toBeVisible()
  await expect(card.getByText(ADDRESS, { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: "test-results/exe-devices-mobile-en-dark.png", fullPage: true })
})
