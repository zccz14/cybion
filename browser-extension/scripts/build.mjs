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

async function seed() {
  const store = await chrome.storage.local.get(["cybion.session", "cybion.pendingThread"])
  const session = store["cybion.session"]
  if (session?.accessToken) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  const next = store["cybion.pendingThread"]
  if (next?.id) {
    await chrome.storage.local.remove("cybion.pendingThread")
    location.hash = "#/threads/" + encodeURIComponent(next.id)
  }
}

await seed()

chrome.storage.onChanged.addListener((changes) => {
  const session = changes["cybion.session"]?.newValue
  if (session?.accessToken) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  const next = changes["cybion.pendingThread"]?.newValue
  if (next?.id) {
    void chrome.storage.local.remove("cybion.pendingThread")
    location.hash = "#/threads/" + encodeURIComponent(next.id)
  }
})

await import(${JSON.stringify(`./assets/${entry}`)})
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
