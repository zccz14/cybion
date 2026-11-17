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

## 组件清单

包有三个入口：`@zccz14/cybion-components` 是组件与 API 客户端，`@zccz14/cybion-components/logic` 是不依赖 React 组件的解析、格式化与输入区钩子（宿主自建外壳时用它，避免把模块复制进自己的树里），`@zccz14/cybion-components/styles.css` 是随包编译好的样式表。下表按用途列出全部导出，新增导出必须同时更新这里（`tests/readme-inventory.test.ts` 会逐条核对）。

### 入口与数据通道

| 导出 | 作用 |
| --- | --- |
| `CybionThreadProvider` | 绑定一个 Cybion 源（`baseUrl` + `getToken` + `identity`），并把查询缓存、语言、链接注入给下层 |
| `useCybion` | 读取 Provider 提供的客户端、语言、`sessionId`、`identity`、`t`、`link` |
| `CybionThreadProviderProps` / `CybionLink` / `CybionLinkProps` | Provider 的参数类型，以及宿主注入路由链接的签名 |
| `CybionThreadView` | 完整对话surface：标题、状态、用量、历史、底部输入区。必填参数只有 `threadId` |
| `CybionThreadViewProps` | 视图的可选宿主钩子：`onTitleChange`、`onThreadChange`、`renderRecord`、`headerActions`、`olderPages`、`readOnly` 等 |
| `CybionThreadClient` | 浏览器 API 客户端；Provider 用它，宿主也可以直接用它调 `/api/*` |
| `CybionApiError` | 非 2xx 响应统一抛出的错误（带 `status`） |
| `CybionClientOptions` / `CybionTokenProvider` | 客户端的构造参数与令牌来源签名 |

### 类型

| 导出 | 作用 |
| --- | --- |
| `Thread` / `ThreadDefaults` | Controller 返回的一条线程，以及账号默认设置 |
| `HistoryRecord` / `ThreadHistoryEntry` / `ThreadHistoryWindow` | 一条历史记录、分组后的条目、一页历史窗口 |
| `ThreadImage` / `threadImage` | 从记录里认出生成的图片、截图或查看过的图片 |
| `ThreadResponseView` | 运行中的流式响应快照 |
| `ThreadUsage` | 累计 token、缓存命中与已结算成本 |
| `ThreadDisplayStatus` | 投影后的展示状态（ready / running / blocked …） |
| `ThreadManualLoadsView` | 一个线程当前加载了哪些手册，以及重放区间 |
| `ManualChoice` / `ModelCatalog` | 手册选择项（只有 id 与名字）、一个上游的模型目录 |
| `ManualSummary` / `Worker` | 记录卡片解析名字用的手册摘要与设备摘要 |
| `HistoryWindow` / `RequestAck` | 历史窗口与「已受理」响应 |
| `UpstreamCatalog` / `UpstreamModels` | 模型目录的单条与整体形状 |
| `Language` / `CopyKey` | 语言联合与文案键；`copyFor` 按下标取字符串 |

### 对话历史渲染

| 导出 | 作用 |
| --- | --- |
| `HistoryMessage` | 一条记录的默认渲染器，按记录类型分派到下面这些卡片；`renderRecord` 不传时就是它 |
| `ThreadHistory` | 记录列表：合并连续过程、成组图片、维护滚动锚点；`minimal` 时只展开每轮最后一条 |
| `ThreadProcessGroup` | 一轮里的工具调用折叠组，带耗时与花费 |
| `ThreadImageGroup` | 连续生成图片的网格 |
| `AssistantMessage` | 助手回复正文（带流式光标） |
| `UserInputMessage` | 用户自己的消息（含图片、语音与脚注） |
| `AudioMessage` | 一条语音附件与转写 |
| `CheckpointMessage` | 压缩产生的检查点 |
| `CopyReplyButton` | 复制整条回复 |
| `BashCommand` | 设备上的 bash 调用与输出 |
| `CybionToolCall` | 控制器侧工具调用（手册、便签等） |
| `WebSearchCall` | 联网搜索调用 |
| `ImageGenerationCall` | 图像生成调用 |
| `BrowserControlCall` / `ComputerUseCall` | 浏览器与桌面操作调用 |
| `ViewImageCall` / `ViewedOutput` | 查看图片的调用与其结果 |
| `ScreenshotOutput` | 截图结果 |
| `ManualLoadNotice` | 手册加载/卸载的控制器记录 |
| `BudgetStopNotice` / `BudgetStopNoticeView` | 花费上限止损记录的卡片与其数据类型；传 `onRaise` 才出现「追加预算」控件 |
| `HistoryRecordPayload` | 任何记录的原始负载折叠视图 |
| `WorkerCallSummary` | Worker 调用结果的摘要行 |

### 输入区

| 导出 | 作用 |
| --- | --- |
| `ComposerAttach` | 附件按钮，把选中的文件交给宿主分流 |
| `ComposerAttachments` | 已附加的图片、语音、文本的胶囊列表 |
| `ComposerFileNotice` / `ComposerLengthNotice` | 「未添加」原因与超长提示 |
| `ComposerAudio` | 录音按钮（计时、发送、取消） |
| `ComposerAudioNotice` | 录音失败、草稿恢复等提示 |
| `ComposerDraftNotice` | 草稿无法写入本地存储时的警告 |
| `useComposerAttach` | 按类型把选中的文件分流到图片/语音/文本 |
| `useComposerFiles` | 文本附件状态（截断、计数、上限） |
| `attachComposerAudio` / `attachComposerImages` | 从扩展或外部把图片、语音送进当前输入区 |
| `ComposerFile` / `SkippedFile` / `SkippedFileReason` | 文本附件与「未添加」的数据形状 |

### 线程设置

十项设置在四个界面上是同一个表单控件：`value` 进、`onChange` 出，默认值与三套模型目录由它自己从 Provider 读取。

| 导出 | 作用 |
| --- | --- |
| `ThreadSettingsFields` | 唯一的设置表单控件；`mode="override"` 可「跟随默认」，`mode="defaults"` 编辑账号默认本身 |
| `ThreadSettingsPopover` | 上面那个控件的弹出式外壳（输入区行内用） |
| `ThreadSettingsButton` | 开箱即用的按钮：只给 `threadId`，自取目录、自行 PATCH 变化的字段 |
| `UsdBudgetInput` | 金额输入（草稿保留小数点，提交纳美元整数） |
| `ThreadSettings` / `ThreadSettingsOverrides` / `ReasoningEffort` | 统一 schema 与写入载荷 |
| `REASONING_EFFORTS` / `THREAD_SETTINGS_FIELDS` | 推理强度档位、schema 的字段清单 |
| `threadSettingsFromThread` / `threadSettingsFromDefaults` / `threadSettingsForNewThread` | 从线程行、账号默认、新建草稿构造这个值 |
| `threadSettingsPatch` / `threadSettingsOverrides` / `threadSettingsDefaults` / `sameThreadSettings` / `budgetTooLarge` | 生成 PATCH、生成默认设置的 PUT 负载、比较两个值、判断金额是否超上限 |
| `imageModelOptions` / `modelGroups` / `modelSelection` / `parseModelSelection` | 模型选择器需要的分组、编码与解析 |

### 状态、用量与滚动

| 导出 | 作用 |
| --- | --- |
| `ThreadStatusSummary` / `ThreadStatusBadge` | 展示状态的一行摘要与徽标 |
| `ThreadUsagePanel` / `ThreadUsageSummary` / `ThreadUsageDetails` | 累计用量面板、行内摘要与明细 |
| `ThreadContextUsage` | 最近一次请求的上下文用量与压缩预算 |
| `MessageScrollerProvider` / `MessageScroller` / `MessageScrollerViewport` / `MessageScrollerContent` / `MessageScrollerItem` / `MessageScrollerButton` | 自建对话滚动容器所需的一组原语（贴底、锚定、「回到底部」） |

### `/logic` 里的纯逻辑

`@zccz14/cybion-components/logic` 按模块整体导出，不引入任何组件与样式表。

| 模块 | 提供 |
| --- | --- |
| `lib/thread-history.ts` | `pollThreadHistory`、`groupThreadHistory`、`groupThreadHistoryMinimal`、`threadHistoryRecordKey`、`liveThreadProcessKey`、`loadedThreadRecords`、`recordInFlight`、`inFlightCallIds`、`newestRecordId`、`oldestRecordId`、`attachThreadProcessSpend`、`threadProcessDuration`、`formatThreadProcessDuration`、`formatThreadProcessSpend`、`isControllerNotice`、`isRestartNotice`、`isRetryNotice` |
| `lib/budget-stop.ts` | `budgetStopNotice`、`DEFAULT_BUDGET_RAISE_USD_NANOS`、`MAX_BUDGET_USD_NANOS` |
| `lib/thread-manual-loads.ts` | `isManualNotice`、`manualLoadNotice` |
| `lib/thread-settings.ts` | 上一节列出的 schema 转换与写入函数 |
| `lib/model-catalog.ts` | 模型目录分组与 `upstream:model` 编解码 |
| `lib/money.ts` | `formatMoney`、`parseMoneyInput`、`sanitizeMoneyInput` |
| `lib/composer-drafts.ts` | `composerDraftKey` 等草稿键 |
| `lib/composer-images.ts` | 图片读取与缩放 |
| `lib/composer-audio.ts` / `lib/composer-audio-drafts.ts` | 录音解析、时长与草稿 |
| `lib/composer-files.ts` | `splitPickedFiles`、`composeComposerInput`、`maxInputChars` |
| `lib/chat-input.ts` | `handleChatInputKeyDown`、`composerAction` |
| `lib/history-payload.ts` | 负载解析（文本、工具调用、图片、音频） |
| `lib/checkpoint-text.ts` | 检查点正文 |
| `lib/thread-response.ts` / `lib/thread-status.ts` / `lib/thread-usage.ts` / `lib/thread-root.ts` | 流式响应、状态文案、用量换算、根节点 class |
| `lib/format.ts` / `lib/time.ts` / `lib/utils.ts` | 字节数、时间、`cn` 与错误信息 |
| `hooks/use-composer-draft.ts` | 按用户与线程隔离的输入草稿 |
| `hooks/use-composer-attach.ts` | `useComposerAttach`：把选中的文件分流到图片/语音/文本 |
| `hooks/use-composer-files.ts` | 文本附件状态（截断、计数、上限） |
| `hooks/use-composer-images.ts` | 已附加图片，以及 `attachComposerImages` |
| `hooks/use-composer-audio.ts` | 录音状态机，以及 `attachComposerAudio` |
| `hooks/use-now.ts` | 定时刷新的当前时间（相对时间显示用） |

文案随包发布：用 `copyFor` 按下标取一条字符串，用 `fillCopy` 填掉模板里的 `{name}` 占位符；文案键的类型 `CopyKey` 也在主入口导出。

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
