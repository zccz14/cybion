/**
 * 内部入口：给本仓库自己的单测与走查页用，不是包的公开面。
 *
 * 它整体再导出公开面，所以一份测试文件里既可以拿 `ThreadSettings`，也可以拿
 * `BashCommand`；引用它的只有本仓库的测试与走查页。
 *
 * 记录卡片（每种工具一张）、复制按钮、几个换算函数只在包内被组装——外面没有人
 * 依赖它们，所以把它们留在 `index.ts` 里等于用一句句签名承诺「以后也不许改」。
 * 但每张卡片仍各有一条回归用例，走查页也要渲染它们：那些用例属于这个仓库，不属
 * 于包的消费者，于是走这个入口。
 *
 * 用法边界：
 * - 公开面（`index.ts` / `logic.ts`）是契约，改动要过 `tests/public-api.test.ts`；
 * - 这里是**内部**，随时可以改名、拆分、删除，引用它的只有仓库内的测试与走查页；
 * - 这个入口不写进 README 的组件清单，发布出去只是为了模块解析能正常工作。
 */
export * from "./index"
export * from "./logic"

// 记录卡片：一张卡片一条回归用例，但只有包自己会把它们拼进对话。
export { AssistantMessage } from "./components/assistant-message"
export { AudioMessage } from "./components/audio-message"
export { BashCommand } from "./components/bash-command"
export { BrowserControlCall } from "./components/browser-control-call"
export { BudgetStopNotice } from "./components/budget-stop-notice"
export { CheckpointMessage } from "./components/checkpoint-message"
export { ComputerUseCall } from "./components/computer-use-call"
export { CopyReplyButton } from "./components/copy-reply-button"
export { CybionToolCall } from "./components/cybion-tool-call"
export { HistoryRecordPayload } from "./components/history-record-payload"
export { ImageGenerationCall } from "./components/image-generation-call"
export { ManualLoadNotice } from "./components/manual-load-notice"
export { ScreenshotOutput } from "./components/screenshot-output"
export { ThreadContextUsage } from "./components/thread-usage"
export { ThreadImageGroup } from "./components/thread-image-group"
export { ThreadProcessGroup } from "./components/thread-process-group"
export { UserInputMessage } from "./components/user-input-message"
export { ViewImageCall } from "./components/view-image-call"
export { ViewedOutput } from "./components/viewed-output"
export { WebSearchCall } from "./components/web-search-call"
export { WorkerCallSummary } from "./components/worker-call-summary"
