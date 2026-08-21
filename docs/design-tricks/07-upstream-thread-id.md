# 稳定 upstream `thread-id`

## 结论

主线程和每个持久子线程都有独立、稳定的 UUID，并作为 `thread-id` header 发送给 OpenAI-compatible upstream。它让 OpenAI-LB 可以按长期线程进行 Provider/channel affinity。

## 语义

```text
main thread → one UUID
subthread A → another UUID
subthread B → another UUID
```

正常请求、工具循环、重试和 checkpoint compaction 复用线程自己的 UUID。它不使用用户可见 history record ID，也不把 `previous_response_id` 当成 Cybion 线程身份。

## 收益与限制

同一长期线程更容易保持上游渠道亲和和缓存条件；它不保证 Provider 永久可用，也不替代完整的 Responses history 或应用授权。

## 相关实现

- `src/main.rs`：upstream thread ID 持久化、request builder、主/子线程运行时
- [`docs/time_awareness.md`](../time_awareness.md)：与稳定上下文前缀的关系
