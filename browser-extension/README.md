# Cybion Browser Extension

Cybion 的第二个 UI：在任意网页上截图，立刻开一个临时 Thread 问一句，答案浮回那个页面。

它不是设备——没有配对、没有注册、没有长连接，也没有无人值守的调用。它跟 `web/` 那个 GUI 走同一套 `/api`，用同一个 Auth Mini JWT，登录态由 GUI 持有、插件只是取过来用。

## 装（开发者模式）

1. Chrome → `chrome://extensions` → 打开右上角「开发者模式」
2. 「加载已解压的扩展程序」→ 选这个目录 `browser-extension/`
3. 在浏览器里打开并登录 `https://cybion.ntnl.io`（插件从这里取登录态）

## 用

- `⌘⇧K`：截当前可见区 → 建一个临时 Thread 问「这是干什么的」→ 答案浮在页面右上角
- 右键菜单「问 Cybion：这是干什么的？」：同上，选中文字时会带上选中的那段
- 点插件图标：看登录态、同步登录态、打开 Cybion

## 有意不做的事

- 不做 Thread 列表、手册、终极机器、设置——那些留在 GUI
- 不自动点击、不填表、不批量翻页；这是有人值守的形态，人是那道门
- 不截整页（`captureVisibleTab` 只能截可见区；整页要上 CDP）
