# Cybion Browser Extension

Cybion 的第二个宿主：侧边栏里渲染的就是 **GUI 自己的构建产物**（`web/dist`），不是另写的前端。按 `⌘⇧K` 截当前可见区，它会开一条 Thread 并把侧边栏带到那条 Thread 上——你人还在原来的页面上。

它复用同一个 Auth Mini JWT（从已登录的 `cybion.ntnl.io` 取过来），所以它不是设备：没有配对、没有注册、没有长连接，也没有无人值守的调用。

## 它只补三件事

`scripts/build.mjs` 把 `web/dist` 拷进 `dist/`，并生成一个引导文件，在 GUI 启动前做三件事：

1. `window.__CYBION_API_BASE__ = "https://cybion.ntnl.io"` —— 扩展页的 origin 不是服务端
2. 把 background 持有的 session 写进 `localStorage['auth-mini.sdk:https://auth.ntnl.io/']` —— 跟 GUI 同一份登录态
3. 有 pending Thread 就设置 `location.hash = "#/threads/<id>"` —— HashRouter 直接落到那条 Thread

## 装

```
pnpm --dir ../web build        # 先有 GUI 产物
pnpm build                     # 拷进 dist/ 并生成 sidepanel.html
```

然后 `chrome://extensions`（或 `edge://extensions`）→ 开发者模式 → 加载已解压的扩展程序 → 选这个目录。

## 有意不做

不自动点击、不填表、不截整页；`⌘⇧K` 只做"截一张可见区 + 开一条 Thread"。
