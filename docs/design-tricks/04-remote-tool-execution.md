# 远程工具执行

## 结论

Cybion 将推理 Controller 与资源附近的 Executor 分离。Controller 编译完整线程上下文、调用上游模型并持久化协议历史；Executor 只接收一项具体工具调用及其参数，执行后返回结果。Executor 仅建立到 Controller 的出站认证 tunnel，不开放公网控制端口。

## 数据流

```text
history_records
→ Controller 编译 context
→ Controller → upstream /responses
→ function_call
→ Controller → Executor: call_id + name + arguments
→ Executor 执行本地资源操作
→ Executor → Controller: call_id + result
→ Controller 持久化 tool_output
→ 下一轮重新编译 context
```

完整 developer policy、checkpoint、工具定义和对话历史不会被重复发送到每个 Executor；Controller 也不向 Executor 下发模型 API key。

## 只出站连接

Executor 主动建立认证 SSE tunnel：

```text
Executor → GET /api/executors/tunnel
Controller → tool call events
Executor → POST tool result
```

这使 NAT、内网或本地 Mac 不需要开放入站端口。连接暂时中断时，工具调用结果仍以 `call_id` 关联；重连策略必须有上限和抖动，避免 controller 更新期间形成重连风暴。

## 设备绑定资源

远端资源必须保持设备归属。例如 Browser session 创建时绑定 `target_device`；后续 snapshot、输入、审批、关闭都通过同一设备执行。省略设备、指定其他设备或 session 不存在时，Controller 拒绝操作。

这项绑定不仅适用于浏览器：任何依赖本地文件、内网、GPU 或设备会话的工具，都应由 Controller 在派发时保留清晰的目标设备边界。

## 收益与限制

Controller 适合靠近上游 AI API；Executor 适合靠近源码、浏览器、内网、数据和硬件资源。Executor 仍可能传输大型工具结果、截图或显式文件，不保证所有跨设备数据都小。Executor 也不是沙箱，部署时仍需最小 OS 权限和独立信任域。

## 相关实现

- `src/main.rs`：`run_agent_items`、`compile_main_context`、`compile_subthread_context`
- `src/main.rs`：`run_executor_tunnel`、远端工具派发、executor pairing
- `src/main.rs`：远端 Browser session owner 校验
- [`docs/threads.md`](../threads.md)
