export type ThreadDisplayStatus = "ready" | "running" | "compacting" | "completed" | "failed" | "stopped"

type StatusCopyKey = ThreadDisplayStatus | `${ThreadDisplayStatus}Hint`

const copy = {
  en: {
    ready: "Ready", readyHint: "No execution yet. Send a message to start.",
    running: "Running", runningHint: "The current request is executing.",
    compacting: "Compacting", compactingHint: "Creating a manual checkpoint.",
    completed: "Completed", completedHint: "The latest execution finished successfully. You can send another message.",
    failed: "Failed", failedHint: "The latest execution failed. Open the thread for error details.",
    stopped: "Stopped", stoppedHint: "Execution was stopped. Saved records are kept and you can continue.",
  },
  zh: {
    ready: "待开始", readyHint: "尚未开始执行，发送消息即可开始。",
    running: "运行中", runningHint: "正在执行本次请求。",
    compacting: "压缩中", compactingHint: "正在压缩重放上下文，生成检查点。",
    completed: "已完成", completedHint: "最近一次执行已成功结束，可以继续发送消息。",
    failed: "执行失败", failedHint: "最近一次执行失败，打开线程查看错误详情。",
    stopped: "已停止", stoppedHint: "执行已停止，已保存的记录保留，可以继续执行。",
  },
} satisfies Record<"en" | "zh", Record<StatusCopyKey, string>>

export function threadStatusText(status: ThreadDisplayStatus, language: "en" | "zh") {
  return { label: copy[language][status], hint: copy[language][`${status}Hint`] }
}

// A running Thread shows what it is doing instead of the generic running label:
// the one-sentence summary the model wrote with the newest unanswered Worker
// call. Every other state, and a running Thread with no Worker call in flight,
// keeps its canonical label.
export function threadStatusLabel(status: ThreadDisplayStatus, language: "en" | "zh", runningSummary?: string | null) {
  const summary = status === "running" ? runningSummary?.trim() : ""
  return summary ? summary : copy[language][status]
}
