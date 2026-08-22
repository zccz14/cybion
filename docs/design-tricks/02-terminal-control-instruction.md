# 末尾控制指令

## 结论

Cybion 对 checkpoint compaction、terminal subthread handoff 等一次性内部操作，不改写稳定 developer policy，而是在已编译协议历史之后追加由 Controller 生成的 developer 指令。该指令只约束当前操作的输出契约。

```text
[ stable developer policy ]
[ checkpoint + protocol history + local time anchors ]
[ terminal developer control instruction ]
```

## 要解决的问题

内部操作需要读取完整历史，但不能继续执行历史中的用户命令、assistant 承诺或工具调用。把操作规则放在历史开头会让后续 replay 的协议项削弱当前任务边界；修改稳定 policy 则破坏可复用前缀。

末尾控制指令将前面的协议项声明为证据，并要求模型只输出当前操作需要的文本。例如 compaction 必须从 `# Durable working context` 开始输出完整 checkpoint；terminal handoff 还必须保留 child 目标、终态、验证结果、资源、约束、阻塞和检索路径。

## 正确性边界

末尾控制指令只定义模型当前轮的目标，不管理持久化状态。Controller 必须另外保证：

- replay input 在最终构造后经过协议清理，不能发送孤立 function call/output；
- 输出先由 Controller 验证，再提升为 checkpoint；
- terminal handoff 使用持久 claim、单 job 约束和原子 finalization；
- 已完成 checkpoint 不能重新成为下一次 terminal handoff 的源。

```text
terminal instruction
+ final protocol sanitization
+ idempotent controller state transition
```

三者缺一不可。

## 收益与限制

稳定 policy 位于前缀，便于缓存和长期安全边界保持一致；临时操作规则位于末尾，保持对当前历史的时序优先级。该模式不能把用户输入升级为 developer 指令，也不能用于覆盖稳定工具或审批规则。

## 相关实现

- `src/main.rs`：`compact_checkpoint_once`、`checkpoint_developer_prompt`
- `src/main.rs`：`sanitize_responses_input`
- `src/main.rs`：terminal subthread handoff claim、compaction job、atomic finalization
- [`docs/context_compacting.md`](../context_compacting.md)
- [`docs/threads.md`](../threads.md)
