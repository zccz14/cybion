# 远端 `call_id` 幂等 ledger

## 结论

每次远端工具调用都有 UUID `call_id`。Executor 将调用状态和结果写入 `executor_tool_calls`，使用它避免断线恢复时重复执行非幂等操作。

## 状态流转

```text
新 call_id → running → complete
                    ↘ unknown（进程在结果确定前重启）
```

重复收到已完成的 `call_id` 时返回既有结果；如果结果为 unknown，则拒绝猜测性重跑。

## 为什么重要

Shell、写文件、编辑文件等操作可能已经在远端成功，但响应在网络中丢失。盲目重试可能造成重复写入、重复部署或重复外部副作用。`call_id` 将请求身份和执行结果绑定起来。

## 边界

该 ledger 只能判断相同 `call_id`，不能替代业务级幂等键，也不能在 unknown 时推断外部系统是否成功。调用方必须对 unknown 做人工或业务层确认。

## 相关实现

- `src/main.rs`：`executor_tool_calls` schema 与启动恢复
- `src/main.rs`：远端派发、结果回传和重复 call 处理
