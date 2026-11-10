// 侧边栏里跑的就是站点本身：登录、存储、路由都归它自己的 origin。
// 插件只做一件事——把刚截的那张图递进草稿页的输入框，然后你自己写问题、自己发。
const APP_ORIGIN = "https://cybion.ntnl.io"
const IMAGE_KEY = "cybion.pendingImage"
const frame = document.getElementById("app")

let pendingImages = []

/** 跨域，只有 postMessage 这一条路；站点那边没挂上 composer 时会自己排队。 */
function handOver() {
  if (pendingImages.length === 0) return
  const target = frame.contentWindow
  if (!target) return
  try {
    target.postMessage({ type: "cybion:attach-images", images: pendingImages }, APP_ORIGIN)
    pendingImages = []
  } catch {}
}

function openDraft() {
  frame.src = `${APP_ORIGIN}/#/threads/new`
}

frame.addEventListener("load", handOver)

async function consume() {
  const stored = await chrome.storage.local.get(IMAGE_KEY)
  const image = stored?.[IMAGE_KEY]
  if (!image?.dataUrl) return false
  await chrome.storage.local.remove(IMAGE_KEY)
  pendingImages = [image.dataUrl]
  return true
}

void (async () => {
  if (await consume()) openDraft()
})()

chrome.storage.onChanged.addListener((changes) => {
  if (!changes?.[IMAGE_KEY]?.newValue?.dataUrl) return
  void (async () => {
    if (await consume()) openDraft()
  })()
})
