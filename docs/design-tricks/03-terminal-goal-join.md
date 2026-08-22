# 持久 Goal 子线程终态 join

## 结论

Cybion 的子线程是持久 Goal，不是第二个用户会话。它拥有独立 thread、模型、历史、checkpoint 和重试状态；达到 `achieved`、`blocked` 或 `cancelled` 后，Controller 将终态结果以主线程可重放的证据交接回来。

## 生命周期

```text
fork Goal
→ queued / running
→ progress / tool calls / checkpoint
→ achieved / blocked / cancelled
→ child terminal handoff checkpoint
→ paired main-thread subthread_handoff evidence
→ main thread continues
```

child checkpoint 只属于 child history，不能成为 main checkpoint。主线程接收的是带 child 标识、终态、结果、证据和检索路由的 paired handoff output；之后主线程自己的 checkpoint 再将这份 evidence 与主线历史共同归约。

## 原子性与恢复

终态交接必须满足：

- 每个终态 child 最多一个 handoff job；
- handoff 使用 child 自己的 upstream thread ID 和 model；
- child checkpoint、main handoff evidence、outcome marker 在原子状态转换中完成；
- 失败时写入一次可检索的 unavailable handoff，不无限重试；
- 重启只恢复已经持久化但未完成的 claim，不能重新解释已完成 checkpoint。

这些约束避免“子线程完成但主线程看不到结果”、重复 join，以及 checkpoint 自我压缩循环。

## 收益与限制

持久 Goal 允许主线程非阻塞地分派独立工程或研究工作，同时保留可审计的任务完成条件和证据。它不代表无限并发；每个 Goal 需要清楚的 done-when，无法继续时必须报告真实外部 blocker。

## 相关实现

- `src/main.rs`：`run_subthread`、Goal 状态持久化、terminal join claim
- `src/main.rs`：terminal handoff compaction 与 atomic finalization
- [`docs/threads.md`](../threads.md)
- [`docs/context.md`](../context.md)
