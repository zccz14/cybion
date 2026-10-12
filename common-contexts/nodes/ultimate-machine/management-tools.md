# 管理工具（tool 套件）

管理终极机器有三件工具：`cybion_list_ultimate_machines`、`cybion_get_ultimate_machine`、`cybion_set_ultimate_machine`。字段级语义以工具描述为准；这里是使用套路。

## 何时用哪件

- **看全貌、找 id**：`cybion_list_ultimate_machines`——每台机器的定义 + 最近一次落定结果（`enabled`、`last_run_at`、`last_exit`、绑定的修复 Thread）。
- **看一台的细节**：`cybion_get_ultimate_machine`——`last_exit`：0 = 正常；其他数字 = 退出码（被杀且无退出码记为 -1）；null = 尚无落定结果（或该次执行未完成/已失联）。
- **新建或修改**：`cybion_set_ultimate_machine`。

## 新建（省略 machine_id）

必填 `name`、`worker_id`、`command`、`interval_seconds`（10–2592000 秒）；可选 `intent`。

- 只能绑定**你拥有的** Worker（共享 Worker 不能跑机器）；拿不准先 `cybion_list_workers`。
- 创建后立即执行第一次，并自动创建修复 Thread「终极机器 · <名称>」。
- 创建前先干跑：用 bash 在目标 Worker 上运行同一命令，确认健康态返回 0、失败输出可读。
- 典型请求「给 MacMini 加一个磁盘检查」：list_workers → bash 干跑 → set 创建 → 一句话向用户确认，别粘贴全文。

## 修改（带 machine_id，局部更新）

- 只提供要改的字段，其余保持不动。
- `intent` 传空串清空意图；省略则保留。
- `enabled: false` 暂停、`true` 恢复（新机器默认启用；`enabled` 仅在更新时可传）。
- 改 `worker_id` 会把机器搬过去，并重启「离线提醒」事件。
- 改名会同步修复 Thread 标题（手动改过标题的除外）。
- 三件套没有删除：要停就暂停；彻底移除由用户删除绑定的修复 Thread 或它使用的 Worker。

## 修复 Thread 里的用法

收到【终极机器·…】失败消息后：

1. `cybion_get_ultimate_machine` 看定义与最近结果；
2. 用 bash 修环境，或先验证修正后的命令；
3. 若检查本身要改，用 `cybion_set_ultimate_machine` 更新命令（顺手核对 `intent` 是否仍然准确）；
4. 无需回复，下一次运行自动复验。

## 礼貌与边界

- 机器是用户的资产：只在用户明确要求或修复需要时创建/修改；批量动作先说计划。
- 命令要便宜、只读、幂等、失败可读（见「怎么写检查命令」）。
- 别把密钥写进命令或输出——失败输出会进入 Thread 历史。
