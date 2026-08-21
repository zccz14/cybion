# 远端 Browser session 所有权绑定

## 结论

Browser Control session 创建后绑定到创建它的 `target_device`。后续 snapshot、截图、导航、输入、审批和关闭都必须通过同一设备，避免 session ID 在多设备环境中被误路由。

## 数据流

```text
browser_create_session(target_device)
  → executor browser session
  → Controller records session owner
  → later action checks session_id + target_device
```

省略设备、指定其他设备、或目标设备不存在时，Controller 拒绝操作。当前 Browser UI 也能让用户选择本机或在线工具执行设备。

## 安全边界

页面内容是未可信输入，不能授权外部联系或敏感操作。点击、表单提交、敏感输入等仍遵守显式审批边界。session 绑定解决路由归属，不等于浏览器页面本身可信。

## 相关实现

- `src/main.rs`：`browser_target_device`、`verify_remote_browser_session`、remote browser tunnel
- `src/browser.rs`：本机隔离 Chromium session
- `web/src/main.tsx`：Browser Control 页面
