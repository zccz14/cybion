# Cybion 设计小巧思

这里记录 Cybion 中值得单独理解的架构设计。每篇文档以当前代码为准，说明它解决的问题、实际边界、收益和限制；这些文档不是营销材料，也不替代 API 契约。

## 目录

1. [推理 Controller 与工具 Executor 分离](./01-controller-executor.md)
2. [只出站的 Executor](./02-outbound-executor.md)
3. [远端 `call_id` 幂等 ledger](./03-call-id-ledger.md)
4. [文件传输绕开模型上下文](./04-file-transfer.md)
5. [Append-only protocol history](./05-append-only-history.md)
6. [稳定时间锚点](./06-time-awareness.md)
7. [稳定 upstream `thread-id`](./07-upstream-thread-id.md)
8. [远端 Browser session 所有权绑定](./08-browser-session-ownership.md)
9. [安全 update helper](./09-safe-update-helper.md)
10. [持久 Goal 子线程终态 join](./10-goal-terminal-join.md)

## 阅读建议

- 先读[推理 Controller 与工具 Executor 分离](./01-controller-executor.md)，理解设备角色。
- 再读[Append-only protocol history](./05-append-only-history.md)和[稳定时间锚点](./06-time-awareness.md)，理解长期上下文。
- 如果要维护远程设备，读[只出站的 Executor](./02-outbound-executor.md)、[幂等 ledger](./03-call-id-ledger.md)和[文件传输](./04-file-transfer.md)。
- 如果要维护长期任务，读[稳定 upstream `thread-id`](./07-upstream-thread-id.md)、[安全 update helper](./09-safe-update-helper.md)和[Goal 子线程终态 join](./10-goal-terminal-join.md)。
