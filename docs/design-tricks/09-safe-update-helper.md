# 安全 update helper

## 结论

Cybion 的自更新不让 Agent 直接下载并替换自身二进制，也不让 `run_bash` 直接重启 `cybion.service`。专用更新路径先校验 Release，再由独立 helper 安装、启动和确认版本。

## 更新流

```text
update_cybion → check latest release → download archive + checksum
→ verify SHA-256 → persist update result → helper installs candidate
→ new process starts with marker → failure can restore previous binary
```

先持久化结果再退出是关键：否则 Controller 自重启会让 ToolResult 丢失，恢复后的子线程可能重放同一个部署命令。

## 限制

更新依赖可验证的 Release、平台资产和服务管理器。更新 helper 解决安装原子性和回滚边界，不替代发布权限、供应链保护或管理员审批。

## 相关实现

- `src/update.rs`：下载、校验、helper、startup marker、rollback
- `src/main.rs`：`update_cybion` tool 与本机自重启保护
- [`docs/introduction.md`](../introduction.md)：产品级能力概览
