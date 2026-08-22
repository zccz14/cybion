# Cybion 设计小巧思

这里记录 Cybion 中决定线程模型、上下文连续性和远程执行边界的设计。每篇文档以当前代码为准，说明它解决的问题、实际边界、收益和限制；这些文档不是营销材料，也不替代 API 契约。

## 核心设计

1. [Append-only protocol history：线程模型的事实基础](./01-append-only-history.md)
2. [末尾控制指令：内部上下文操作的任务边界](./02-terminal-control-instruction.md)
3. [持久 Goal 子线程终态 join](./03-terminal-goal-join.md)

这三项共同定义 Cybion 的长期线程模型：不可变协议历史保存事实；末尾控制指令执行一次性上下文转换；子线程终态以可追溯证据加入主线程。

## 支撑设计

4. [远程工具执行：Controller、只出站 Executor 与设备绑定资源](./04-remote-tool-execution.md)
5. [稳定时间锚点](./05-time-awareness.md)

## 阅读建议

- 先读 [Append-only protocol history](./01-append-only-history.md)，理解 Cybion 为什么以协议记录而不是内存对话数组作为线程事实来源。
- 再读 [末尾控制指令](./02-terminal-control-instruction.md) 和 [持久 Goal 子线程终态 join](./03-terminal-goal-join.md)，理解上下文压缩与线程交接如何保持可恢复。
- 需要维护多设备工具时，读 [远程工具执行](./04-remote-tool-execution.md)；需要理解跨日和长期任务时，读 [稳定时间锚点](./05-time-awareness.md)。
