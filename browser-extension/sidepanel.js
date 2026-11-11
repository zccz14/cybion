// 侧边栏里跑的就是站点本身：登录、存储、路由都归它自己的 origin。
// 插件补站点做不到的两件事：把刚截的那张图递进草稿页的输入框；录一段语音递进去。
// 录音必须在这里做——网页（iframe）在这个位置拿不到麦克风，扩展页可以（audioCapture）。
const APP_ORIGIN = "https://cybion.ntnl.io"
const IMAGE_KEY = "cybion.pendingImage"
const RETRY_MS = 400
const MAX_ATTEMPTS = 25

const frame = document.getElementById("app")

/** 面板角落的状态条：任何一步失败都能一眼看出，也顺便报出当前加载的是哪一版。 */
const status = document.createElement("div")
status.style.cssText =
  "position:fixed;right:8px;bottom:8px;z-index:9;pointer-events:none;" +
  "padding:2px 9px;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;" +
  "font:11px/1.7 -apple-system,BlinkMacSystemFont,sans-serif;opacity:0;transition:opacity .18s"
document.body.append(status)

let statusTimer = 0
function showStatus(text, sticky = false) {
  status.textContent = text
  status.style.opacity = "1"
  clearTimeout(statusTimer)
  if (!sticky) statusTimer = setTimeout(() => { status.style.opacity = "0" }, 2600)
}

showStatus(`Cybion 扩展 v${chrome.runtime.getManifest().version}`)

/* ---------- 录音：网页里拿不到麦克风，扩展页可以（manifest 的 audioCapture） ---------- */

let recorder = null
let recordedStream = null
let chunks = []
let canceled = false
let pendingAudio = []
let audioAttempts = 0
let audioTimer = 0

function panelButton(text, title, background) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = text
  button.title = title
  button.style.cssText =
    "border:0;cursor:pointer;border-radius:999px;height:28px;padding:0 10px;color:#fff;" +
    "font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;background:" + background
  return button
}

/** 面板左下角那条：平时只有一个麦克风按钮，录音时变成「发送 / 取消」。 */
const micBar = document.createElement("div")
micBar.style.cssText =
  "position:fixed;left:8px;bottom:8px;z-index:10;display:flex;align-items:center;gap:6px;" +
  "padding:4px;border-radius:999px;background:rgba(0,0,0,.72);box-shadow:0 2px 10px rgba(0,0,0,.25)"
document.body.append(micBar)

function renderMic() {
  micBar.replaceChildren()
  if (recorder && recorder.state !== "inactive") {
    const stop = panelButton("■ 放进草稿", "停止录音并放进草稿", "#c0392b")
    stop.onclick = stopRecording
    const cancel = panelButton("✕", "取消这段录音", "#3a3f47")
    cancel.onclick = cancelRecording
    micBar.append(stop, cancel)
    return
  }
  const mic = panelButton("🎤", "录一段语音", "#2a2f36")
  mic.onclick = () => void startRecording()
  micBar.append(mic)
}

async function startRecording() {
  try {
    recordedStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (error) {
    showStatus(`拿不到麦克风：${error?.name ?? error}`, true)
    return
  }
  canceled = false
  chunks = []
  const next = new MediaRecorder(recordedStream)
  next.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  next.onstop = () => {
    const tracks = recordedStream?.getTracks() ?? []
    tracks.forEach((track) => track.stop())
    recordedStream = null
    recorder = null
    renderMic()
    const blob = canceled ? new Blob([]) : new Blob(chunks, { type: next.mimeType || "audio/webm" })
    chunks = []
    if (canceled) {
      canceled = false
      showStatus("已取消录音")
      return
    }
    if (blob.size === 0) {
      showStatus("没录到声音", true)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== "string") return
      pendingAudio = [reader.result]
      audioAttempts = 0
      showStatus("语音录好了，正在放进草稿…", true)
      startAudioRetry()
    }
    reader.readAsDataURL(blob)
  }
  recorder = next
  next.start()
  renderMic()
  showStatus("录音中…", true)
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop()
}

function cancelRecording() {
  canceled = true
  stopRecording()
}

function flushAudio() {
  if (pendingAudio.length === 0) {
    stopAudioRetry()
    return
  }
  try {
    frame.contentWindow?.postMessage({ type: "cybion:attach-audio", audio: pendingAudio }, APP_ORIGIN)
  } catch {}
  if (++audioAttempts >= MAX_ATTEMPTS) {
    stopAudioRetry()
    showStatus("站点没有回执，语音没进草稿", true)
  }
}

function startAudioRetry() {
  audioAttempts = 0
  if (!audioTimer) audioTimer = setInterval(flushAudio, RETRY_MS)
  flushAudio()
}

function stopAudioRetry() {
  if (audioTimer) {
    clearInterval(audioTimer)
    audioTimer = 0
  }
}

renderMic()

let pendingImages = []
let attempts = 0
let timer = 0

/** hash 变化不会触发 iframe 的 load，所以不能只在 load 时发一次：发到站点回执为止。 */
function flush() {
  if (pendingImages.length === 0) {
    stopRetry()
    return
  }
  const target = frame.contentWindow
  if (target) {
    try {
      target.postMessage({ type: "cybion:attach-images", images: pendingImages }, APP_ORIGIN)
    } catch {}
  }
  if (++attempts >= MAX_ATTEMPTS) {
    stopRetry()
    showStatus("站点没有回执，截图没送进草稿", true)
  }
}

function startRetry() {
  attempts = 0
  if (!timer) timer = setInterval(flush, RETRY_MS)
  flush()
}

function stopRetry() {
  if (timer) {
    clearInterval(timer)
    timer = 0
  }
}

function openDraft() {
  frame.src = `${APP_ORIGIN}/#/threads/new`
  startRetry()
}

function banner(text) {
  if (document.getElementById("cybion-banner")) return
  const strip = document.createElement("div")
  strip.id = "cybion-banner"
  strip.textContent = text
  strip.style.cssText =
    "flex:0 0 auto;padding:6px 10px;font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
    "background:#fdecec;color:#b3261e;border-bottom:1px solid #f5c2c0"
  document.body.style.display = "flex"
  document.body.style.flexDirection = "column"
  frame.style.flex = "1"
  frame.style.minHeight = "0"
  document.body.prepend(strip)
}

window.addEventListener("message", (event) => {
  if (event.origin !== APP_ORIGIN) return
  const data = event.data
  if (data?.type === "cybion:attached-audio") {
    pendingAudio = []
    stopAudioRetry()
    showStatus("语音已放进草稿")
    return
  }
  if (data?.type === "cybion:attached-images") {
    pendingImages = []
    stopRetry()
    showStatus("截图已送进草稿")
    return
  }
  if (data?.type === "cybion:capabilities" && data.mediaDevices === false) {
    banner("这个环境里拿不到麦克风（navigator.mediaDevices 不存在），录音暂时不可用。")
  }
})

frame.addEventListener("load", () => {
  if (pendingImages.length > 0) startRetry()
  if (pendingAudio.length > 0) startAudioRetry()
})

async function consume() {
  const stored = await chrome.storage.local.get(IMAGE_KEY)
  const image = stored?.[IMAGE_KEY]
  if (!image?.dataUrl) return false
  await chrome.storage.local.remove(IMAGE_KEY)
  pendingImages = [image.dataUrl]
  showStatus("收到截图，正在送进草稿…", true)
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
