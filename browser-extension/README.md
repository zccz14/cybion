# Cybion Browser Extension

Cybion 的第二个宿主：侧边栏里嵌的就是 `https://cybion.ntnl.io` 本身——登录、存储、路由全归站点自己的 origin，插件不种会话、不注入 API 基址、也不打包前端。

插件只做两件事：

1. `⌘⇧K`（或右键菜单）截当前可见区，用同一个 Auth Mini JWT 建一条 Thread 并把截图发进去
2. 把侧边栏里的框换到那条 Thread 上（`#/threads/<id>`）

它不是设备：没有配对、没有注册、没有长连接，也没有无人值守的调用。

## 为什么是 iframe 而不是打包产物

打包 `web/dist` 要在扩展 origin 里重建站点的运行环境：种一份会话、把 API 基址指回服务端、还要绕开扩展自己的 Service Worker。这些都是自己给自己找的活，而且每一处都会单独坏一次。iframe 把这些整块省掉，代价只有两条：跨域驱动路由只能换 `src` 的 hash；第三方上下文里的登录归浏览器分区策略管（第一次可能要在框里登一次）。

## 装

无构建步骤：`chrome://extensions`（或 `edge://extensions`）→ 开发者模式 → 加载已解压的扩展程序 → 选这个目录。

## 有意不做

不自动点击、不填表、不截整页；侧边栏里不另做一套 UI——那边就是 GUI。
