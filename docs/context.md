# 上下文编译规范

## 目标

一次发往 Responses API 的上下文由 developer 前缀和持久化历史窗口组成：

```text
context = developer_prefix + sanitize(compile(history_records, idx_tail))
```

`idx_tail` 是一次请求开始前、已持久化且允许进入模型上下文的最后一条 `history_records` 记录
ID。`idx_head` 是编译器根据 `history_records`、`idx_tail`、线程和 checkpoint 规则推导出的
回放起点。二者共同标识一次上下文窗口：`[idx_head, idx_tail]`，但实际取项时仍必须精确过滤
线程和协议记录类别。

`developer_prefix` 是上下文的第一项 developer 协议消息，位于清洗后的历史协议项之前。模型、
工具定义等请求参数不属于本规范定义的 `context`。

本规范是目标行为，而非对当前实现的符合性声明。

## 术语与前提

`H` 表示按 `id` 唯一排序的不可变 `history_records` 集合。每条记录至少有：

- `id`：全局递增的记录 ID；不同线程的写入可以交错。
- `thread_id`：`NULL` 表示主线程，非空值表示该子线程。
- `kind`：记录类别。
- `payload`：可回放的 Responses 协议项。

只有下列 **协议记录** 可以进入历史上下文：

```text
input | response_output | tool_output | checkpoint
```

`activity` 是运行和控制台状态，必须完全排除：不得作为 `idx_tail`、不得作为 `idx_head`、不得
参与 checkpoint 查找，也不得出现在发往 Responses API 的上下文中。调用方必须选择一条协议记录
作为 `idx_tail`；不存在、不是协议记录，或不属于可访问线程边界的 ID 都是编译错误。

给定 `H` 和合法的 `idx_tail`，`idx_head` 与编译结果必须只由两者决定。编译器不得读取上一轮请求遗留在内存中
的 `items` 作为额外输入。

定义：

```text
protocol(H, thread, lo, hi)
  = H 中 lo <= id <= hi、thread_id 精确等于 thread、kind 为协议记录的项，按 id 升序排列

last_checkpoint(H, thread, hi)
  = H 中 id <= hi、thread_id 精确等于 thread、kind = checkpoint 的最大 id

first_protocol(H, thread, hi)
  = H 中 id <= hi、thread_id 精确等于 thread、kind 为协议记录的最小 id
```

数值区间只界定 ID 范围，线程条件始终独立应用。因此，主线程和兄弟子线程的记录即使 ID 落在
同一数值区间，也不会混入对方的上下文。

## 编译算法

### 1. 确定线程

读取 `H[idx_tail]`：

- `thread_id = NULL`：按主线程算法编译。
- `thread_id = child_id`：按子线程算法编译，并读取
  `subthreads[child_id].from_record_id` 作为 `fork_from_id`。

`fork_from_id` 必须存在，且必须指向一条主线程记录。否则该子线程上下文无效。

### 2. 主线程

设：

```text
idx_head = last_checkpoint(H, main, idx_tail)
```

若存在 `idx_head`，上下文窗口为：

```text
protocol(H, main, idx_head, idx_tail)
```

checkpoint 本身必须包含在窗口中。若不存在 checkpoint，则令 `idx_head` 为
`first_protocol(H, main, idx_tail)`，窗口为：

```text
protocol(H, main, idx_head, idx_tail)
```

若没有任何主线程协议记录，编译失败。

### 3. 子线程

设 `fork_from_id = subthreads[child_id].from_record_id`。先在子线程自身的数值范围内寻找：

```text
idx_head = max(id | fork_from_id <= id <= idx_tail,
                        thread_id = child_id,
                        kind = checkpoint)
```

#### 子线程已有 checkpoint

若存在 `idx_head`，子线程已经包含继承状态。上下文窗口仅为：

```text
protocol(H, child_id, idx_head, idx_tail)
```

#### 子线程没有 checkpoint

若不存在子线程 checkpoint，在主线程中寻找不晚于 fork 点的最后一个 checkpoint，并令
`idx_head` 为该 checkpoint：

```text
idx_head = last_checkpoint(H, main, fork_from_id)
```

若存在 `idx_head`，主线程段为：

```text
protocol(H, main, idx_head, fork_from_id)
```

否则，令 `idx_head = first_protocol(H, main, fork_from_id)`。子线程段始终为：

```text
protocol(H, child_id, fork_from_id, idx_tail)
```

最终窗口按“主线程段在前、子线程段在后”拼接。`fork_from_id` 本身属于主线程；子线程段的数值
范围包含该 ID，但精确线程过滤保证它不会重复出现。

若主线程段或子线程段所需的协议记录不存在，编译失败，而不是退回到其他子线程或内存状态。

## 清洗中间件

`compile(H, idx_tail)` 返回按上述规则装配的原始协议项。随后必须创建其副本并执行清洗：

```text
sanitize(compile(H, idx_tail))
```

清洗只改变待发送的副本，绝不修改 `history_records.payload`。清洗完成后的顺序保持原始窗口顺序。

### Web Search 与 Image Generation 协议字段

对每个 `type = web_search_call` 项，删除：

```text
action
```

对每个 `type = image_generation_call` 项，删除：

```text
size
action
```

这些都是上游 Responses 重放兼容性要求；历史中保留原始字段，以支持完整审计和未来兼容性修正。

若上游兼容性还要求其他类型移除字段，该规则必须显式列入本节及回归测试，不能隐式地依赖某次
内存中的请求改写。

### `function_call` 与 `function_call_output`

在完整窗口中，按 `call_id` 汇总 `function_call` 和 `function_call_output`。一个调用对仅在满足
以下全部条件时保留：

1. `call_id` 是非空字符串；
2. 恰好有一个 `function_call`；
3. 恰好有一个同 `call_id` 的 `function_call_output`；
4. `function_call` 在数组中的位置严格早于其输出。

不满足条件的调用和输出都必须移除，包括孤立项、重复项和顺序颠倒项。其他协议项保持不变。

## 请求、持久化与重试

每次非重试的 Responses 调用遵循以下顺序：

1. 选择当前线程最后一条协议记录为 `idx_tail`，并由 `H` 和 `idx_tail` 推导 `idx_head`。
2. 用 `sanitize(compile(H, idx_tail))` 生成历史上下文并发送请求。
3. 将响应中的每个协议输出按原顺序写入 `history_records`。
4. 执行工具后，将每个工具输出写入 `history_records`。
5. 下一次调用重新选择新的 `idx_tail`，并重新推导 `idx_head`、重新编译；只要步骤 3 或 4
   写入了协议记录，新的 `idx_tail` 必须严格大于上一次的 `idx_tail`。

传输层重试期间若没有新增协议记录，必须复用同一个 `idx_tail` 并重新计算相同的历史上下文。上下文
溢出时，压缩请求也必须标注其输入的 `idx_head` 和 `idx_tail`；压缩结果作为新的 `checkpoint`
持久化后，重试请求以该 checkpoint 的记录 ID 作为新的 `idx_tail` 重新编译。

## 审计要求

每一条 Responses 请求审计必须记录下列派生值：

| 字段 | 含义 |
| --- | --- |
| `idx_head` | 由 `H` 与 `idx_tail` 计算出的窗口起点。 |
| `idx_tail` | 该请求的编译尾部；这是上下文快照的主身份。 |
| `thread_id`、`request_kind` | 归属与用途。 |

`idx_head` 可以在多个请求间保持不变；`idx_tail` 则应在有新协议记录的非重试请求间严格递增。
审计页面应把两者分别展示，不能用 `idx_head` 替代 `idx_tail`。

## 可验证性

实现必须覆盖至少以下回归场景：

1. 相同 `H` 和 `idx_tail` 两次编译产生深度相等、顺序相等的清洗后上下文，并推导相同的
   `idx_head`。
2. 主线程有和没有 checkpoint 的窗口选择。
3. 子线程有自身 checkpoint；以及没有自身 checkpoint、回退到主线程 checkpoint 的拼接。
4. 全局 ID 交错时不混入兄弟子线程记录。
5. `activity` 不能作为 `idx_tail` 或进入编译、checkpoint 查找和最终上下文。
6. 模型输出与工具输出落库后，下一次非重试请求的 `idx_tail` 推进。
7. 纯传输重试不推进 `idx_tail`，且请求上下文相等。
8. Web Search 与 Image Generation 字段清洗不改写持久化 payload。
9. 重复、孤立或倒序的 `function_call` / `function_call_output` 被成对移除；唯一且有序的调用对被保留。
