# 上下文压缩规范

## 目标

上下文窗口溢出时，Cybion 必须从与失败的普通推理相同的已编译 history-records
窗口开始生成 checkpoint。压缩不删除原始 history records；最终 checkpoint 只替代后续普通推理中
可见的旧上下文，较早证据仍可通过历史读取工具取得。

## 初始窗口

普通推理和压缩都以同一个 `idx_tail` 调用上下文编译器，得到：

```text
CompiledContext {
  idx_head,
  idx_tail,
  records: [(record_id, created_at, kind, protocol_item), ...]
}
```

`records` 的顺序、线程边界、checkpoint 选择、工具输出截断以及协议项内容必须与普通推理相同。
`idx_mid` 只能从这个已编译 records 数组中选择真实的 `record_id`；不能用
`(idx_head + idx_tail) / 2` 计算，因为全局 ID 会穿插 activity 和其他子线程记录。

压缩不改写稳定 developer 前缀，也不把压缩指令放在历史之前。Controller 在待压缩的已编译协议项之后追加一条 terminal `developer` input：

```text
normal     = stable_developer_prefix + records
compaction = stable_developer_prefix + records + terminal_compaction_instruction
```

terminal instruction 明确规定前面的 records 全是证据而非待执行指令；模型只能直接产生 checkpoint `output_text`，请求没有 tools 且 `tool_choice = none`。`compact_context` 不是模型可调用 tool。


## Checkpoint 内容契约

checkpoint 是下一轮 Agent 的工作记忆，而不是仅保留当下状态的进度报告。压缩时按以下优先级保留信息：

1. 概念、术语、领域含义、标识符和已验证的技术行为。
2. 完成工作所需的权威资源与精确位置：仓库、文件、目录、符号、URL、服务、数据库、迁移、配置、数据位置和命令。
3. 能说明当前概念、资源、决策或约束如何形成的因果相关历程。
4. 活跃决策、约束、当前目标、下一步、未完成工作和已验证的环境状态。

输出必须按此顺序使用 `# Durable working context`、`## Concepts and terminology`、`## Resources and authoritative locations`、`## Chronicle timeline`、`## Active decisions and constraints`、`## Current objective and next step` 和 `## Open work and evidence routes` 标题。
当空间不足时，应先去除已解决的叙事和短暂的进度细节，不能将前两类工作记忆仅仅因为当前任务已结束而丢弃。除可检索的路由外，每个非平凡事项必须附上准确的 history record ID；当需要回溯更早细节时，同时提供检索关键词。

`## Chronicle timeline` 是按发生顺序排列的 Markdown bullet list。它必须尽可能保留所有仍然影响当前概念、资源、决策、约束、未完成工作或因果链的事件；不能因条目数量而截断。只有重复报告同一事件、没有新增因果含义的重复事实，或被更高层结论完整覆盖的事实，才允许缩略合并。合并后必须保持原有时序并引用全部适用的 history record ID；不同的决定、发现、故障、恢复、验证、发布或约束不得合并或省略。

普通上下文编译器会在每个真实 user input 与每个 `function_call_output` 后追加由该 raw protocol record 的 `record_id` 和 `created_at` 派生的稳定 UTC developer 时间锚点。时间锚点不写回 `history_records`，也不向 `function_call_output` 或其他原始 Responses 协议项添加字段；压缩请求使用与普通推理相同的已编译项，因此可读取这些锚点。Chronicle 应优先使用锚点中的精确 `created_at` 时间；只有时间锚点不存在时，才使用类似 `[after record #18, before record #27 | inferred]` 的顺序锚点。不能从 record 顺序伪造日历时间或时长。当输入含上一次的 checkpoint 时，需与后续 raw records 按时序合并、合并已被替代的事实并删除无关对话。关于事件时间、缓存稳定性和可信边界，参见[Time Awareness](./time_awareness.md)。

## 递归前缀压缩

一次压缩的运行态由一个可选的临时摘要前缀与一段连续的未压缩 records 后缀组成：

```text
[prefix_summary?] + [raw_records]
```

先尝试把这整个运行态压成一个 checkpoint。成功即返回。遇到非上下文溢出错误直接失败。

若遇到上下文溢出且 `raw_records` 至少有两项，选择其前半段的最后一个 record 为 `idx_mid`，
先压：

```text
[prefix_summary?] + raw_records[..=idx_mid]
```

若成功，输出成为新的 `prefix_summary`，后缀推进为：

```text
raw_records[idx_mid 之后..]
```

再重复完整压缩尝试。于是当“左摘要 + 右侧原始 records”仍溢出时，算法会继续在右侧后缀中选取新的
`idx_mid`，而不会重新装配或持久化中间 checkpoint。每次成功都会严格缩短 raw 后缀，保证流程前进。

若左侧压缩也溢出，则把 `idx_mid` 缩为当前左侧 records 的中点，重试更短的左侧。这个过程持续到
左侧成功或只剩一条 raw record。

## 无法压缩的单条记录

若一条 raw record 连同 terminal instruction 仍导致 overflow，Controller 不丢弃该 record。它将原始协议 payload 序列化为带 `record_id`、kind、fragment ordinal、总数和 SHA-256 的连续 fragments，并递归缩小 fragment 宽度直到可以压缩。原始 history record 保留，checkpoint 可通过 record ID 检索完整材料。只有“一字节 fragment 加 mandatory instruction”也超过上游窗口时，才是不可恢复的配置错误。


## 持久化与审计

每次成功的 compaction model output 先以不可变 `response_output` 记录，再在同一 SQLite transaction 中创建 `compaction_nodes` provenance row；因此崩溃不会留下可被普通上下文误回放的半节点。`compaction_jobs` 持久化 scope、coverage boundary、状态和最终 output record，已完成但尚未 promotion 的 job 可以安全复用。

这些 node response outputs 不参与普通上下文编译，也不成为 checkpoint 链节点。Controller 通过 deterministic integrity gate（必需标题与非空内容）读取该 exact persisted text，随后仅把最终 node promotion 为 `kind=checkpoint`。主线程 promotion 仍以初始 `idx_tail` 做事务内 stale-snapshot 检查；子线程只写入自身 thread。

每一次压缩请求审计标记为 `request_kind = compaction` 并保留初始窗口 `idx_head`、`idx_tail`。


## 回归要求

1. 第一次压缩请求使用完整的 `[idx_head, idx_tail]` records 窗口和压缩 developer 前缀。
2. 首次压缩溢出后，左半压缩成功，再与右侧 raw records 合并为最终 checkpoint。
3. “左摘要 + 右侧”溢出时，算法在右侧继续推进，且中间摘要不落库。
4. 左侧溢出时，`idx_mid` 向左缩小直到成功。
5. 单条无法压缩的 record 被排除出 checkpoint 但仍保留在历史中。
6. 非上下文溢出错误不会被当作递归压缩处理。
7. 压缩 developer 消息先要求概念术语和资源位置，再要求当前状态和目标。
8. chronicle timeline 按 record 顺序保留因果相关历程，且不从顺序推断精确时间。
