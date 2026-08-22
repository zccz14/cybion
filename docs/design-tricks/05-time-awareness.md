# 稳定时间锚点

## 结论

Cybion 从不可变 history record 的 `id` 和 `created_at` 派生 UTC developer 时间锚点，紧跟真实 user input 与 `function_call_output`。这样普通推理可以理解跨日期任务，而每次请求不会因为动态“当前时间”改变缓存前缀。

## 解决的问题

长任务可能在一天开始、第二天收到工具结果。没有事件时间时，模型可能把工具结果的日期误判为未来，从而错误怀疑系统时钟或部署状态。

## 约束

时间来自记录持久化时间，不是 compaction 请求的当前时间。时间锚点不写回 `history_records`，也不改变标准 `function_call_output` 的 `type`、`call_id`、`output` 字段。

同一记录再次编译时会产生相同锚点，首次升级会改变上下文格式，之后保持稳定。

## 相关实现

- `src/main.rs`：协议记录加载与时间 anchor 派生
- [`docs/time_awareness.md`](../time_awareness.md)
