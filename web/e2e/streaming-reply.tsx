import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { AssistantMessage } from "../src/components/assistant-message"
import "../src/styles.css"

/*
 * The controller hands the browser a whole snapshot of a running reply, and the browser polls it.
 * This fixture polls the same way — one snapshot every 600 ms — so the surface is exercised the way
 * Cybion drives it: same prop replaced by growing content, never a delta stream.
 */
const snapshots = [
  "## 部署状态\n\n",
  "## 部署状态\n\n- **检查通过**：服务健康。\n",
  "## 部署状态\n\n- **检查通过**：服务健康。\n- 命令：`git status`\n",
  "## 部署状态\n\n- **检查通过**：服务健康。\n- 命令：`git status`\n\n```bash\n",
  "## 部署状态\n\n- **检查通过**：服务健康。\n- 命令：`git status`\n\n```bash\ngit status --short\nexit 0\n```\n",
  "## 部署状态\n\n- **检查通过**：服务健康。\n- 命令：`git status`\n\n```bash\ngit status --short\nexit 0\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 部署 | 通过 |\n",
]

declare global {
  interface Window {
    __stream: { snapshots: number; final: string }
  }
}

function Fixture() {
  const [step, setStep] = useState(0)
  const [streaming, setStreaming] = useState(true)

  useEffect(() => {
    window.__stream = { snapshots: snapshots.length, final: snapshots[snapshots.length - 1] }
    const timer = window.setInterval(() => setStep((current) => Math.min(current + 1, snapshots.length - 1)), 600)
    return () => window.clearInterval(timer)
  }, [])

  // The last snapshot is the record becoming durable: the preview stops being live.
  useEffect(() => {
    if (step < snapshots.length - 1) return
    const settled = window.setTimeout(() => setStreaming(false), 1_500)
    return () => window.clearTimeout(settled)
  }, [step])

  return <main data-stream={streaming ? "live" : "done"} className="mx-auto flex min-h-svh max-w-3xl flex-col gap-4 bg-background p-6 text-foreground">
    <AssistantMessage language="zh" streaming={streaming} text={snapshots[step]} time="12:34:56" />
  </main>
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
