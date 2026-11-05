/**
 * What the account numbers mean. The administrator's Users page and an
 * account's own Usage statistics page report the same figures from the same
 * sources, so both pages read these lines instead of keeping a copy each.
 */
export const accountMetricNotes = {
  zh: {
    usageNote: "推理请求包含普通推理和上下文压缩，覆盖所有状态。Token 为上游已报告的输入与输出之和，缓存率 = 缓存输入 Token ÷ 输入 Token。无输入用量时显示 —。请求和 Token 基于保留的审计记录；删除线程会移除相关审计。",
    runningNote: "运行中的线程按当前责任方分为三态：推理（等待模型上游响应，含上下文压缩）、设备（已交给 Worker，排队或执行中）、内核（Cybion 控制端：控制器工具、编译手册、退避重试、收尾）。三态之和等于运行中的线程数。待恢复表示线程处于运行状态但本控制器没有执行任务，通常出现在重启后的几秒内。",
    networkNote: "流量为累计值，分别显示 Cybion 向 Worker / 推理上游发送和接收的 HTTP 正文字节，包含 Worker 心跳和 SSE 帧，不含 HTTP 头与 TLS 开销。",
    sqliteNote: "SQLite 为该用户数据库主文件、WAL 与 SHM 文件的合计。",
    workersNote: "Workers 为该用户名下未删除的设备数量；他人共享给该用户的设备不计入。",
  },
  en: {
    usageNote: "Requests include inference and manual compaction in every status. Tokens add reported input and output usage; cache rate = cached input tokens ÷ input tokens. No input usage displays —. Request and token totals use retained audits; deleting a thread removes its audits.",
    runningNote: "Running Threads are split by who owes the next step: inference (waiting on the model upstream, including manual compaction), device (handed to a Worker, queued or executing), and kernel (the Cybion Controller: controller tools, manual compilation, retry backoff, finalization). The three always add up to the running total. Unattended means a Thread is marked running but this Controller holds no task for it, usually for a few seconds after a restart.",
    networkNote: "Traffic is a running total: sent and received HTTP body bytes between Cybion and Workers / inference upstreams, including Worker heartbeats and SSE framing, excluding HTTP headers and TLS overhead.",
    sqliteNote: "SQLite includes the user's main database, WAL and SHM files.",
    workersNote: "Workers counts the user's devices that are not deleted; devices shared with the user are excluded.",
  },
} as const
