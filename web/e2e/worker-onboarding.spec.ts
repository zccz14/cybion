import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
const release = JSON.parse(readFileSync(new URL("../../worker-release.json", import.meta.url), "utf8"))
async function fixture(page: Page, scenario = "success") {
  let approved = false
  let checking = false
  let posts = 0
  const created = Math.floor(Date.now()/1000)
  const device = { id: "target", label: "Fixture Mac", status: "online", created_at: created, last_seen_at: created }
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let body: unknown = {}
    if (path === "/api/worker-release") body = release
    else if (path === "/api/workers") body = approved ? [device] : []
    else if (path.startsWith("/api/worker-pairings/")) {
      if (route.request().method() === "POST") { approved = true; posts++ }
      body = { id: "session", user_code: "ABCD-1234-EF56", hostname: "Fixture Mac", platform: "macos / aarch64", version: "0.1.4", expires_at: created+600, worker_id: "target", status: scenario === "expired" ? "expired" : approved ? "approved" : "pending" }
    } else if (path === "/api/workers/target/check") {
      if (route.request().method() === "POST") checking = true
      body = checking ? { id: "check", worker_id: "target", created_at: created, completed_at: created, status: scenario === "timeout" ? "timed_out" : "completed", result: scenario === "timeout" ? null : { shell: { status: "ready", detail: "shell_ok" }, browser: { status: "not_checked", detail: "browser_installed" }, desktop: { status: "not_checked", detail: "desktop_permissions" } } } : null
    }
    await route.fulfill({ json: body })
  })
  return { posts: () => posts }
}
test("explicit consent, exact-device check, refresh restoration and prefilled first task", async ({ page }) => {
  const state = await fixture(page)
  await page.goto("/e2e/fixture.html#/workers?code=ABCD-1234-EF56")
  const approve = page.getByRole("button", { name: "确认连接这台设备" })
  await expect(approve).toBeDisabled()
  await page.getByRole("checkbox").check()
  await approve.click()
  await expect(page.getByText("命令执行已验证，可开始使用",{exact:true})).toBeVisible()
  expect(state.posts()).toBe(1)
  await page.reload()
  await expect(page.getByText("命令执行已验证，可开始使用",{exact:true})).toBeVisible()
  expect(state.posts()).toBe(1)
  await page.getByRole("link", {name:"开始使用这台设备"}).click()
  await expect(page.getByTestId("draft")).toContainText("worker_id: target")
})
test("remote platform instructions and mobile layout remain usable in both languages", async ({ page }) => {
  await fixture(page)
  await page.setViewportSize({width:390,height:844})
  await page.goto("/e2e/fixture.html#/workers")
  await page.getByRole("radio",{name:"另一台电脑或服务器"}).check()
  await page.getByRole("combobox").click()
  await page.getByRole("option",{name:"Linux · ARM64"}).click()
  await expect(page.getByText("以下命令必须在目标电脑或服务器运行，不是在当前浏览器所在设备运行。",{exact:true}).first()).toBeVisible()
  await expect(page.getByRole("link",{name:"下载 Worker"})).toHaveAttribute("href",/linux-aarch64.tar.gz$/)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  await page.getByRole("button",{name:"Language",exact:true}).click()
  await expect(page.getByRole("heading",{name:"Connect a device",exact:true})).toBeVisible()
  await page.screenshot({path:"test-results/worker-onboarding-mobile.png",fullPage:true})
})
test("expired codes and failed checks do not report readiness", async ({ page }) => {
  await fixture(page,"expired")
  await page.goto("/e2e/fixture.html#/workers?code=ABCD-1234-EF56")
  await expect(page.getByText("配对已过期。请在目标设备重新运行 Worker，获取新配对码。",{exact:true})).toBeVisible()
  await expect(page.getByRole("button",{name:"确认连接这台设备"})).toHaveCount(0)
})
test("timed-out task channel exposes recovery instead of a success CTA", async ({ page }) => {
  await fixture(page,"timeout")
  await page.goto("/e2e/fixture.html#/workers?code=ABCD-1234-EF56")
  await page.getByRole("checkbox").check()
  await page.getByRole("button",{name:"确认连接这台设备"}).click()
  await expect(page.getByText(/检查超时。可能是/)).toBeVisible()
  await expect(page.getByRole("link",{name:"开始使用这台设备"})).toHaveCount(0)
})

test("shows the reported version and confirms an owner-requested remote upgrade", async ({ page }) => {
  let posts=0
  let status="queued"
  const device={id:"upgradable",label:"Upgrade Mac",created_at:1,last_seen_at:Math.floor(Date.now()/1000),status:"online",version:"0.2.0",can_upgrade:true}
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname
    let body:unknown={}
    if(path==="/api/worker-release") body={...release,version:"v0.2.1"}
    if(path==="/api/workers") body=[{...device,upgrade:posts ? {version:"v0.2.1",status,error:status==="failed"?"checksum mismatch":null}:null}]
    if(path==="/api/workers/upgradable/upgrade") {posts++;body={ok:true}}
    await route.fulfill({json:body})
  })
  await page.goto("/e2e/fixture.html#/workers")
  await expect(page.getByText("运行版本: 0.2.0",{exact:true})).toBeVisible()
  page.on("dialog",dialog=>dialog.accept())
  await page.getByRole("button",{name:/升级 Worker/}).click()
  await expect(page.getByText("正在等待任务结束或安装升级…",{exact:true})).toBeVisible()
  expect(posts).toBe(1)
  await expect(page.getByRole("button",{name:/升级 Worker/})).toBeDisabled()
  status="failed"
  await page.reload()
  await expect(page.getByText(/checksum mismatch/)).toBeVisible()
})
