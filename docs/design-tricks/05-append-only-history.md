# Append-only protocol history

## 结论

`history_records` 是 Cybion 对话协议事实的持久来源。当前只保存四类可重放记录：`input`、`response_output`、`tool_output`、`checkpoint`；记录默认不可变。

## 作用

每轮推理依据 thread、`idx_head` 和 `idx_tail` 从 SQLite 重新编译上下文，而不是依赖易失的内存对话数组。服务重启、页面刷新和子线程详情重开时，仍可以从同一批记录恢复。

```text
immutable protocol records → context compilation → upstream Responses request → new records
```

## 收益与限制

Append-only 让审计边界清楚，也让 checkpoint 能表达覆盖范围。它不是无限历史的免费存储：工具结果仍需截断或转为文件对象，数据库也需要管理 payload 大小。

执行过程的临时 activity 不属于长期 protocol history；实时执行状态通过运行时事件展示，避免把运行日志复制进可重放上下文。

## 相关实现

- `src/main.rs`：`history_records` schema、`load_protocol_items`、context compilation
- [`docs/context.md`](../context.md)
- [`docs/context_compacting.md`](../context_compacting.md)
