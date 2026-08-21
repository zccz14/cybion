# 文件传输绕开模型上下文

## 结论

`copy_files` 不把文件内容塞入模型 prompt，而使用独立的分块传输面在设备之间传送归档，并用大小、offset 和 SHA-256 校验。

## 数据流

```text
source file/directory → tar.gz archive → ordered chunks through Controller relay
→ target archive → checksum verify → safe extraction
```

工具结果只需要返回传输状态、路径和校验信息；模型不需要看到二进制内容才能完成复制。

## 收益与限制

这减少 Token 消耗、上游上传量和历史污染，也避免把二进制误当作模型可读文本。传输仍会消耗设备与 Controller 带宽；大工具输出和截图也不会自动变小。

安全解包必须拒绝绝对路径、`..` 路径、符号链接和非常规归档成员。源文件权限和目标路径仍是调用方必须审查的安全边界。

## 相关实现

- `src/main.rs`：`copy_files`、transfer session、offset 与 SHA-256
- `README.md`：文件传输限制与安全规则
- [`docs/context.md`](../context.md)：文件对象与上下文边界
