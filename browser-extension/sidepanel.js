// 侧边栏里跑的就是站点本身：登录、存储、路由都归它自己的 origin，
// 插件只负责"哪条 Thread"这一件事——在框里换一次 hash。
const APP_ORIGIN = "https://cybion.ntnl.io"
const PENDING_KEY = "cybion.pendingThread"
const frame = document.getElementById("app")

function go(threadId) {
  const next = threadId ? `${APP_ORIGIN}/#/threads/${encodeURIComponent(threadId)}` : APP_ORIGIN
  // 跨域：contentWindow.location 一律不可读，只能整份重设 src。
  // 赋同一个值本身就是一次重载，所以这里不做比较。
  frame.src = next
}

void (async () => {
  const stored = await chrome.storage.local.get(PENDING_KEY)
  const pending = stored?.[PENDING_KEY]
  if (pending?.id) {
    await chrome.storage.local.remove(PENDING_KEY)
    go(pending.id)
  }
})()

chrome.storage.onChanged.addListener((changes) => {
  const pending = changes?.[PENDING_KEY]?.newValue
  if (pending?.id) {
    void chrome.storage.local.remove(PENDING_KEY)
    go(pending.id)
  }
})
