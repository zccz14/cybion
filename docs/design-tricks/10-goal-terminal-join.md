# 持久 Goal 子线程终态 join

## 结论

Cybion 的子线程是持久 Goal，而不是第二个用户会话。它可以并行执行独立工作，终态结果会原子地加入主线程历史，再由主线程继续推理。

## 生命周期

```text
fork Goal → queued / running → progress, retry, checkpoint
→ achieved / blocked / cancelled → terminal result joins main history
```

子线程拥有自己的 `thread_id`、模型、历史和重试状态。主线程不会因为 fork 而阻塞；子线程达到终态后，主线程收到结构化结果和证据。

终态 join 必须是原子的：不能出现“子线程已经完成，但主线程看不到结果”或同一终态重复加入的情况。重启恢复会根据持久状态继续或收敛到终态。

## 收益与限制

该模型适合独立、可验证的工程或研究任务，但不是无限制并发。每个 Goal 都应有清晰 done-when 条件；无法继续时必须报告具体外部 blocker，而不是无限重试。

## 相关实现

- `src/main.rs`：`run_subthread`、Goal 状态持久化、terminal join
- [`docs/threads.md`](../threads.md)
- [`docs/context.md`](../context.md)
