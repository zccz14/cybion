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
  records: [(record_id, protocol_item), ...]
}
```

`records` 的顺序、线程边界、checkpoint 选择、工具输出截断以及协议项内容必须与普通推理相同。
`idx_mid` 只能从这个已编译 records 数组中选择真实的 `record_id`；不能用
`(idx_head + idx_tail) / 2` 计算，因为全局 ID 会穿插 activity 和其他子线程记录。

压缩请求与普通推理的区别只有请求专用的 developer 前缀：

```text
normal     = normal_developer_prefix     + records
compaction = compaction_developer_prefix + records
```

压缩请求不附带普通 Agent 的工具定义。发送前仍经过同一 Responses replay sanitizer；它只改变
请求副本，不改写持久化 history records。

## Checkpoint 内容契约

checkpoint 是下一轮 Agent 的工作记忆，而不是仅保留当下状态的进度报告。压缩时按以下优先级保留信息：

1. 概念、术语、领域含义、标识符和已验证的技术行为。
2. 完成工作所需的权威资源与精确位置：仓库、文件、目录、符号、URL、服务、数据库、迁移、配置、数据位置和命令。
3. 能说明当前概念、资源、决策或约束如何形成的因果相关历程。
4. 活跃决策、约束、当前目标、下一步、未完成工作和已验证的环境状态。

输出必须按此顺序使用 `# Durable working context`、`## Concepts and terminology`、`## Resources and authoritative locations`、`## Chronicle timeline`、`## Active decisions and constraints`、`## Current objective and next step` 和 `## Open work and evidence routes` 标题。
当空间不足时，应先去除已解决的叙事和短暂的进度细节，不能将前两类工作记忆仅仅因为当前任务已结束而丢弃。除可检索的路由外，每个非平凡事项必须附上准确的 history record ID；当需要回溯更早细节时，同时提供检索关键词。

`## Chronicle timeline` 是按发生顺序排列的 Markdown bullet list，最多 12 条。仅收录状态变化、决策、关键发现、故障、验证和发布等因果相关事件；每条需含时间或顺序锚点与关联的 history record ID。只有原始上下文明确给出时，才能写日期、时间或时长；否则必须以类似 `[after record #18, before record #27 | inferred]` 的顺序锚点标注推断，不能从 record 顺序伪造日历时间或时长。当输入含上一次的 checkpoint 时，需与后续 raw records 按时序合并、合并已被替代的事件并删除无关对话。

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

一条 raw record 连同已有临时摘要仍导致上下文溢出时，该记录不进入 checkpoint，算法继续处理其后的
records。它不会从 `history_records` 删除，仍可由 `search_thread_history` 和
`read_thread_history` 按需读取。实现必须记录该恢复事件，避免把“未进入 checkpoint”误认为原始历史丢失。

若所有 raw records 已处理而压缩请求本身仍溢出，则向上返回该错误；不进行无限重试。

## 持久化与审计

临时摘要只存在于本次压缩运行内，绝不写入 `history_records`。仅最终摘要被写成一个 checkpoint record。
主线程写入前必须在同一事务中确认最后一条主线程协议记录仍为初始 `idx_tail`；子线程同样只把最终摘要
写入其自身线程。

每一次压缩请求审计均标记为 `request_kind = compaction`，并保留初始窗口的 `idx_head`、`idx_tail`，以便
将它与触发压缩的普通推理请求对应起来。

## 回归要求

1. 第一次压缩请求使用完整的 `[idx_head, idx_tail]` records 窗口和压缩 developer 前缀。
2. 首次压缩溢出后，左半压缩成功，再与右侧 raw records 合并为最终 checkpoint。
3. “左摘要 + 右侧”溢出时，算法在右侧继续推进，且中间摘要不落库。
4. 左侧溢出时，`idx_mid` 向左缩小直到成功。
5. 单条无法压缩的 record 被排除出 checkpoint 但仍保留在历史中。
6. 非上下文溢出错误不会被当作递归压缩处理。
7. 压缩 developer 消息先要求概念术语和资源位置，再要求当前状态和目标。
8. chronicle timeline 按 record 顺序保留因果相关历程，且不从顺序推断精确时间。
