# @zccz14/cybion-components

把 Cybion 的一个 Thread 完整嵌进你的界面：标题、状态、累计用量与成本、历史记录（推理、工具调用、Worker 输出、图片、检查点）、以及底部输入区（模型与推理强度、压缩、停止/继续、语音输入）。

数据直接来自 Cybion 的浏览器 API，鉴权用宿主已有的 Auth Mini JWT（令牌的 `aud` 里要包含 Cybion 的域名）。

## 用法

```tsx
import { CybionThreadProvider, CybionThreadView } from "@zccz14/cybion-components"
import "@zccz14/cybion-components/styles.css"

<CybionThreadProvider
  baseUrl="https://cybion.ntnl.io"
  getToken={() => authMini.sdk.getAccessToken({ audience: "cybion.ntnl.io" })}
  identity={userId}
  language="zh"
>
  <CybionThreadView threadId={threadId} />
</CybionThreadProvider>
```

`CybionThreadView` 唯一的必填参数是 `threadId`。其余都是可选的宿主钩子：

| 参数 | 用途 |
| --- | --- |
| `onTitleChange` | Thread 改标题时同步到宿主自己的记录 |
| `renderRecord` | 用宿主自己的记录渲染替换默认卡片 |
| `readOnly` | 只读浏览，不渲染输入区 |

## 主题

样式表自带 Tailwind 工具类，并优先读取宿主已有的 shadcn 令牌（`--background`、`--card`、`--primary`…）；宿主没有定义时退回到内置的浅色/深色默认值。深色模式跟随宿主根节点上的 `.dark`。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build   # dist/index.js + dist/index.d.ts + dist/styles.css
```

## 宿主适配与提取等价性

组件保留提取前的独立 React Query 查询、缓存键、失效规则和轮询节奏：Thread 1500ms，历史在运行时 1200ms / 空闲时 2500ms，流式响应运行时 750ms。模型目录失败不会阻塞对话，操作错误不会被下一次成功轮询抹掉。

- React、React DOM、`@tanstack/react-query` 和 `@zccz14/ux` 是宿主共享的 peer dependencies，必须解析到同一份运行时。
- 宿主已有 React Query 时，把同一个 `queryClient` 和 `sessionId` 交给 Provider；发送、控制、改标题及设置继续使列表、历史、审计等原查询失效。不传时 Provider 自带缓存。
- `link` 注入宿主路由链接（如 `({ href, ...props }) => <Link to={href} {...props} />`），同时覆盖手册加载通知与工具卡片。
- `olderPages` / `onOlderPage` 让路由外壳保留已加载页（**最老页在前**）；不传则保存在 Provider 缓存中。
- `onThreadChange` / `onRecordsChange` 用于宿主的归档、手册查询等联动；`headerLeading` / `headerActions` / `transcriptFooter` 只放宿主自己的导航和面板。
- `loadAudio` 可复用宿主的会话级音频 URL 缓存；默认客户端也会按引用缓存下载，失败可重试。
- `threadId` 改变会重建本地输入/录音状态，草稿仍按用户和 Thread 隔离。切换账号时，宿主应像 Cybion 一样以用户 ID key 工作区/Provider。

回归基准为提取前 `bc67cc6`（PR #697 的父提交），不是已经发生变化的组件实现。`web/e2e/thread-view-parity.spec.ts` 在两份实现上运行同一组黑盒交互测试；其它端到端用例继续守护记录渲染、图片、滚动、设置、分享等行为。

## npm 发布

在 npm 上把 Trusted Publisher 指向 `zccz14/cybion` 的 `release.yml`，并启用仓库变量 `NPM_COMPONENTS_PUBLISH=true`。发布任务使用 `id-token: write`、npm 11 与 provenance，不需要 npm token。

正常 `v*` 标签发布同时发布尚未存在的组件版本。只需发布 npm 包时（不重新部署控制器），在已通过 CI 的主干执行：

```sh
gh workflow run release.yml --ref main -f components_only=true
```

发布前须先通过 PR 更新包版本；已存在的版本会跳过，不能覆盖 npm 的不可变版本。
