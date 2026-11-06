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
| `intro` | 宿主已有、尚未写进 Thread 的第一条消息（例如工单正文） |
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
