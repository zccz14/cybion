# 末尾控制指令

## 结论

Cybion 对一次性内部操作不改写稳定 developer prefix，而是在已经编译的协议历史之后追加一条由 Controller 生成的 developer 指令。这个**末尾控制指令**定义当前操作的唯一目标和输出契约。

它适用于 checkpoint compaction、terminal subthread handoff 等需要分析已有上下文、但不能把已有上下文继续当作待执行对话的操作。

## 问题

普通 Agent 请求的稳定 developer prefix 承载长期不变的规则，例如工具边界、设备约束和线程角色。每次为了内部操作修改它会产生两个问题：

1. 稳定前缀变化，降低上游 prompt cache 的复用机会；
2. 内部操作规则若放在历史开头，后续 replay 的 user、assistant、developer 和工具协议项仍可能让模型把历史末尾误判为当前待继续的工作。

checkpoint compaction 的输入尤其具有这种形态：它需要读取完整历史，却不能执行或回答历史中的指令。

## 结构

```text
[ stable developer prefix ]
[ compiled protocol history ]
[ terminal developer control instruction ]
```

末尾指令是 Controller 构造的 developer item，不来自用户输入，也不写入普通会话的稳定 prefix。它明确规定：

- 前面的所有协议项都是待分析的证据；
- 不回答用户、不继续执行任务、不调用工具；
- 本轮只产生指定的内部输出；
- 输出必须满足确定的格式和持久化契约。

在 compaction 中，末尾指令要求模型只返回从 `# Durable working context` 开始的完整 checkpoint Markdown。对于 terminal handoff，它额外要求保留 child 的目标、终态、已验证结果、权威资源、约束、阻塞条件和检索路径。

## 实际边界

`compact_checkpoint_once` 在历史 items 后追加 `checkpoint_developer_prompt(...)`，并设置：

```json
{
  "tool_choice": "none"
}
```

所以 compaction 不复用普通 Agent 的工具集，也不会由模型选择一个外部工具作为压缩结果。Controller 从模型的 `output_text` 创建可审计的 compaction output，再按 job / checkpoint 规则持久化。

稳定 developer prefix 仍由普通 `scoped_responses_request_body` 构造。这使普通 Agent 与内部 compaction 可以共享不变前缀，同时让本轮控制规则位于已 replay 历史之后。

## 收益

- **保留稳定缓存前缀**：通用 developer 约束不会因 checkpoint 或 handoff 任务而变化。
- **保持协议历史原貌**：历史继续使用其真实角色和顺序，而不是被拼接成容易失真的纯文本 transcript。
- **明确本轮意图**：最新 developer 控制项将内部任务与历史里的用户任务、旧 assistant 承诺和工具输出区分开。
- **缩小模型职责**：模型只负责生成指定输出；Controller 负责验证、持久化、状态转换和恢复。

## 限制与必要条件

末尾控制指令只解决模型的当前轮指令边界，不替代 Controller 状态机。

任何由末尾控制指令触发的持久化操作必须有独立的幂等完成条件。例如 terminal subthread handoff 必须用持久 claim 限制为每个 child 一次，并将 child checkpoint、主线程 handoff evidence 和 terminal outcome 原子提交。否则，新的 checkpoint 可能被调度器重新解释为下一次内部操作的输入，形成自循环。

同样，所有 replay 的 Responses input 必须在最终请求构造后经过协议清理：孤立 `function_call` 或 `function_call_output` 不得被发送给上游。

因此该模式的正确性由三部分共同构成：

```text
terminal developer control instruction
+ final protocol-input sanitization
+ idempotent controller state transition
```

## 适用条件

适合采用末尾控制指令的操作具有以下特征：

- 输入是现有协议历史或其他不可变证据；
- 任务只在当前请求有效；
- 不能改变普通 Agent 的长期身份和工具边界；
- 输出由 Controller 而非模型负责纳入持久状态。

不应把用户提供的文本升级为末尾 developer 指令，也不应把它作为绕过稳定安全约束的机制。

## 相关实现

- `src/main.rs`：`compact_checkpoint_once`、`checkpoint_developer_prompt`、`scoped_responses_request_body`
- `src/main.rs`：`sanitize_responses_input`
- `src/main.rs`：terminal subthread handoff claim、compaction job 与原子 finalization
- [`docs/context_compacting.md`](../context_compacting.md)
- [`docs/threads.md`](../threads.md)
