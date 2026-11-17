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

## 公开面

两个入口：`@zccz14/cybion-components`（组件与钩子）、`@zccz14/cybion-components/styles.css`（样式表）。`/logic` 是纯解析与格式化的子路径，测试用；`/internal` 是**本仓库内部**入口，不是契约。

导出的东西只有两类：**组件**，和**替组件把数据流做完的钩子**。一个能渲染表单、却把读取/比较/保存留给调用方的组件没有封装任何东西——它把内部实现写成了调用方的待办清单。所以设置面板配三个钩子，而不是导出 `threadSettingsPatch` 那类算法（那些名字留在包内）。`tests/public-api.test.ts` 冻结整份清单。

## Props

下表是每个组件的完整 props。所有组件的 `language` 都是 `"en" | "zh"`。

### 嵌入整个对话

| 组件 | Props |
| --- | --- |
| `CybionThreadProvider` | `baseUrl: string` · `getToken: () => string \| Promise<string>` · `identity?: string` · `sessionId?: string` · `language?: Language` · `queryClient?: QueryClient` · `link?: CybionLink` · `fetch?: typeof fetch` · `children: ReactNode` |
| `CybionThreadView` | `threadId: string`（唯一必填）· `className?: string` · `onTitleChange?: (title: string) => void` · `onThreadChange?: (thread: Thread) => void` · `onRecordsChange?: (records: HistoryRecord[]) => void` · `workers?: Worker[]` · `manuals?: ReadonlyMap<string, ManualSummary>` · `loadAudio?: (reference: string, mediaType: string \| null) => Promise<string>` · `renderRecord?: (record: HistoryRecord, context: { inFlight: boolean }) => ReactNode` · `headerActions?: ReactNode` · `headerLeading?: ReactNode` · `transcriptFooter?: ReactNode` · `olderPages?: ThreadHistoryWindow[]` · `onOlderPage?: (threadId: string, page: ThreadHistoryWindow) => void` · `readOnly?: boolean` |

### 历史

| 组件 | Props |
| --- | --- |
| `HistoryMessage` | `record: HistoryRecord` · `inFlight: boolean` · `workers?: Worker[]` · `manuals?: ReadonlyMap<string, ManualSummary>` · `loadAudio?: (reference: string, mediaType: string \| null) => Promise<string>` · `onRaiseBudget?: (addedUsdNanos: number) => void` · `raisingBudget?: boolean` |
| `ThreadHistory` | `records: readonly HistoryRecord[]` · `minimal: boolean` · `running: boolean` · `renderRecord: (record: HistoryRecord) => ReactNode` |

### 用量与状态

| 组件 | Props |
| --- | --- |
| `ThreadUsagePanel` / `ThreadUsageSummary` / `ThreadUsageDetails` | `usage: ThreadUsage` |
| `ThreadStatusBadge` | `status: ThreadDisplayStatus` · `runningSummary?: string \| null` |

### 输入区

| 组件 | Props |
| --- | --- |
| `ComposerAttach` | `disabled: boolean` · `onFiles: (files: File[]) => void` |
| `ComposerAttachments` | `images: string[]` · `audios?: string[]` · `files?: ComposerFile[]` · `onRemove: (index: number) => void` · `onRemoveAudio?: (index: number) => void` · `onRemoveFile?: (index: number) => void` |
| `ComposerAudio` | `recording: boolean` · `disabled: boolean` · `phase?: ComposerAudioPhase` · `elapsed?: number` · `onStart: () => Promise<boolean>` · `onSend: () => void` · `onCancel: () => void` |
| `ComposerAudioNotice` | `error: ComposerAudioError \| null` · `restored?: number` · `onDismiss?: () => void` · `onDismissRestored?: () => void` · `onRetry?: () => void` |
| `ComposerFileNotice` | `skipped: SkippedFile[]` |
| `ComposerLengthNotice` | `chars: number` · `limit: number` |
| `ComposerDraftNotice` | `storageError: boolean` |

### 设置

| 组件 | Props |
| --- | --- |
| `ThreadSettingsFields` | `value: ThreadSettings` · `onChange: (value: ThreadSettings) => void` · `mode?: "override" \| "defaults"` · `idPrefix?: string` · `disabled?: boolean` |
| `ThreadSettingsPopover` | `value: ThreadSettings` · `onChange: (value: ThreadSettings) => void` · `disabled?: boolean` |
| `ThreadSettingsButton` | `threadId: string` · `value?: Thread` · `disabled?: boolean` · `className?: string` · `defaultOpen?: boolean` |

`mode="override"` 用于线程（每项可「跟随默认」），`mode="defaults"` 用于账号默认（值本身就是默认）。

## 钩子

每个钩子把某个界面的数据流整段包好，宿主只递值。

| 钩子 | 返回 |
| --- | --- |
| `useThreadDefaultsForm({ queryKey? })` | `value: ThreadSettings \| null` · `onChange` · `changed` · `canSave` · `save()` · `pending` · `error: Error \| null` · `saved` · `loading` · `retry()` |
| `useNewThreadSettings({ queryKey? })` | `value: ThreadSettings \| null` · `onChange` · `model`（`model`/`upstream_id`/`reasoning_effort`/`service_tier_fast`）· `payload`（其余七项，随第一条消息发出）· `loading` · `error` · `retry()` |
| `useThreadSettingsPanel(threadId, { value?, enabled? })` | `value: ThreadSettings \| null` · `onChange`（只 PATCH 变化的字段）· `pending` · `thread` |
| `useComposerDraft(identity, threadId \| null)` | `input` · `setInput` · `seed` · `clearSubmitted` · `storageError` |
| `useComposerFiles()` / `useComposerImages()` / `useComposerAudio({ scope })` | 附件状态与增删 |
| `useComposerAttach({ images, audio, files })` | `(files: File[]) => void`，按类型分流 |
| `useNowSeconds()` | 定时刷新的当前秒数（相对时间用） |

`ThreadSettings` 的十一项与 `/api/thread-defaults`、Thread 行同名：`model`、`upstream_id`、`reasoning_effort`、`service_tier_fast`、`context_budget_tokens`、`minimal_mode`、`image_generation_model`、`audio_transcription_model`、`max_loaded_manuals`、`initial_manual_ids`、`budget_usd_nanos`。七项可为 `null`，含义是「跟随账号默认」。

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
