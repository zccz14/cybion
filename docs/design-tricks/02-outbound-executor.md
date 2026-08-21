# 只出站的 Executor

## 结论

Executor 不监听公网控制端口，而是主动通过认证 SSE tunnel 连接 Controller。这样家用 Mac、办公内网机器和 NAT 后设备无需开放入站端口。

## 建立连接

```text
Executor → GET /api/executors/tunnel → HTTPS + Executor access token
Controller 推送 tool call；Executor POST tool result
```

配对 token 一次性使用并短期有效；Controller 保存设备访问凭证的 hash，而不是可直接复用的明文值。

## 收益与限制

这种拓扑降低了公网暴露面，设备是否在线由 Controller 的 tunnel 状态判断。它依赖 Executor 能够出站访问 Controller；如果出站网络中断，工具调用无法完成，但不应被自动重复执行。

它不是沙箱：Executor 仍拥有被授予的本机工具权限，部署时应使用最小 OS 权限和独立信任域。

## 相关实现

- `src/main.rs`：Executor 启动分支、`run_executor_tunnel`
- `src/main.rs`：pairing endpoint、executor token hash、设备在线状态
- `README.md`：Executor / Controller 部署说明
