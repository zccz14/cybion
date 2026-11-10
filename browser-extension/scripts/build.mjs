// 插件不自带前端：它把 GUI 的构建产物（web/dist）装进侧边栏，只补三样东西——
// 指回服务端的 API 基址、GUI 已经持有的登录态、以及要把你带到哪条 Thread。
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const webDist = path.resolve(root, "../web/dist")
const out = path.resolve(root, "dist")
const API_BASE = "https://cybion.ntnl.io"
const SESSION_KEY = "auth-mini.sdk:https://auth.ntnl.io/"

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(webDist, out, { recursive: true })

const assets = await readdir(path.join(out, "assets"))
const entry = assets.find((name) => /^app-.*\.js$/.test(name))
const style = assets.find((name) => /^app-.*\.css$/.test(name))
if (!entry) throw new Error("web/dist/assets 里没有 app-*.js：先跑 pnpm --dir web build")

// MV3 的扩展页禁止内联脚本，所以引导代码必须是一个自己的文件。
const bootstrap = `// 由 browser-extension/scripts/build.mjs 生成，不要手改。
window.__CYBION_API_BASE__ = ${JSON.stringify(API_BASE)}

const SESSION_KEY = ${JSON.stringify(SESSION_KEY)}

/** JWT 的 exp 是唯一可靠的"现在还能不能用"，缓存的 expiresAt 字段可能早就不准了。 */
function expiresAt(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const decoded = JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)))
    return (decoded.exp ?? 0) * 1000
  } catch {
    return 0
  }
}

function notice(message) {
  const root = document.getElementById("root")
  if (!root) return
  root.innerHTML = ""
  const card = document.createElement("div")
  card.style.cssText = "margin:20px;padding:16px 18px;border:1px solid var(--border, #d8d8d8);border-radius:12px;font:13px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:var(--foreground,#111)"
  const title = document.createElement("div")
  title.textContent = "侧边栏还差一次登录"
  title.style.cssText = "font-weight:600;margin-bottom:6px"
  const body = document.createElement("div")
  body.textContent = message
  body.style.cssText = "color:var(--muted-foreground,#666);margin-bottom:12px"
  const open = document.createElement("button")
  open.textContent = "打开 cybion.ntnl.io 登录"
  open.style.cssText = "margin-right:8px;padding:5px 10px;border:1px solid var(--border,#d8d8d8);border-radius:8px;background:transparent;font:inherit;cursor:pointer;color:inherit"
  open.onclick = () => chrome.tabs.create({ url: ${JSON.stringify(API_BASE)} })
  const retry = document.createElement("button")
  retry.textContent = "登录好了，重试"
  retry.style.cssText = "padding:5px 10px;border:1px solid var(--border,#d8d8d8);border-radius:8px;background:transparent;font:inherit;cursor:pointer;color:inherit"
  retry.onclick = () => location.reload()
  card.append(title, body, open, retry)
  root.append(card)
}

async function seed() {
  const reply = await chrome.runtime.sendMessage({ type: "cybion:session-now" }).catch(() => null)
  const session = reply?.session
  if (!session?.accessToken) {
    notice("插件还没拿到 Cybion 的登录态。打开站点登录一次，插件会自动取过来。")
    return false
  }
  if (expiresAt(session.accessToken) <= Date.now()) {
    notice("拿到的那份登录态已经过期，而且没能自动续期。打开站点登录一次就好。")
    return false
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return true
}

if (await seed()) {
  const stored = await chrome.storage.local.get(["cybion.pendingThread"])
  const next = stored["cybion.pendingThread"]
  if (next?.id) {
    await chrome.storage.local.remove("cybion.pendingThread")
    location.hash = "#/threads/" + encodeURIComponent(next.id)
  }

  chrome.storage.onChanged.addListener((changes) => {
    const session = changes["cybion.session"]?.newValue
    if (session?.accessToken && expiresAt(session.accessToken) > Date.now()) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    }
    const pending = changes["cybion.pendingThread"]?.newValue
    if (pending?.id) {
      void chrome.storage.local.remove("cybion.pendingThread")
      location.hash = "#/threads/" + encodeURIComponent(pending.id)
    }
  })

  await import(${JSON.stringify(`./assets/${entry}`)})
}
`
await writeFile(path.join(out, "bootstrap.js"), bootstrap)

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cybion</title>
    ${style ? `<link rel="stylesheet" crossorigin href="./assets/${style}" />` : ""}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./bootstrap.js"></script>
  </body>
</html>
`
await writeFile(path.join(out, "sidepanel.html"), html)
console.log(`sidepanel.html + bootstrap.js 就绪，入口 ${entry}`)
