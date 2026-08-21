# 推理 Controller 与工具 Executor 分离

## 结论

Cybion 将长期推理与本地工具执行分为两个角色：Controller 编译上下文并调用上游 Responses API；Executor 只接收一次具体工具调用并返回结果。

## 要解决的问题

完整上下文可能包含大量历史、checkpoint、工具定义和时间锚点。让每台工具机器都重复接收这份上下文，会浪费带宽，也会让工具设备持有不必要的模型配置与长期历史。

## 实际数据流

```text
history_records → Controller 编译 context → Controller → upstream /responses
→ function_call → Controller → Executor: name + arguments + call_id
→ Executor 执行工具 → Executor → Controller: output + call_id
→ Controller 写入 tool_output → 下一轮重新编译 context
```

Executor 不参与 `compile_main_context` 或 `compile_subthread_context`，也不保存 OpenAI API key 和模型上下文。

## 收益与限制

收益是把大流量的 Controller↔AI 路径与资源附近的 Executor↔本地资源路径分开。Executor 仍可能传输大工具结果、截图或显式文件，因此这不是“所有跨设备数据都很小”的保证。

Controller 适合靠近上游 AI API；Executor 适合靠近源码、内网、浏览器或 GPU。最终应测量各段 RTT，而不是只看地理位置。

## 相关实现

- `src/main.rs`：`run_agent_items`、`compile_main_context`、`compile_subthread_context`
- `src/main.rs`：`run_executor_tunnel`、远端工具派发
- [`docs/context.md`](../context.md)
