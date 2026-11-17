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

包只有三个入口：`@zccz14/cybion-components`（组件）、`@zccz14/cybion-components/logic`（不依赖 React 的解析与输入区钩子）、`@zccz14/cybion-components/styles.css`（样式表）。

导出的名字就是契约：宿主一旦引用，形状就不能随便改。所以这里只放**宿主真的要用的东西**——嵌入整个对话、或用自己的外壳拼装同一批部件所需的那部分。`tests/public-api.test.ts` 冻结了这份清单，新增一行是刻意决定，不是副作用。

### 主入口

| 导出 | 作用 |
| --- | --- |
| `CybionThreadProvider` | 绑定一个 Cybion 源（`baseUrl` + `getToken` + `identity`），把查询缓存、语言、路由链接注入下层 |
| `CybionThreadView` | 完整对话：标题、状态、用量、历史、底部输入区。必填参数只有 `threadId` |
| `CybionThreadProviderProps` / `CybionThreadViewProps` / `CybionLink` / `CybionLinkProps` | 上面两个组件的参数类型，以及宿主注入路由链接的签名 |
| `HistoryMessage` | 一条历史记录的默认渲染器；`renderRecord` 不传时就是它 |
| `ThreadHistory` | 记录列表：合并连续过程、成组图片、维护滚动锚点 |
| `ThreadUsagePanel` / `ThreadUsageSummary` / `ThreadUsageDetails` | 累计用量面板、行内摘要与明细 |
| `ComposerAttach` / `ComposerAttachments` | 附件按钮与已附加项的胶囊列表 |
| `ComposerFileNotice` / `ComposerLengthNotice` / `ComposerDraftNotice` | 「未添加」原因、超长提示、草稿无法保存的警告 |
| `ComposerAudio` / `ComposerAudioNotice` | 录音按钮与录音失败、草稿恢复提示 |
| `attachComposerAudio` / `attachComposerImages` | 从扩展或外部把语音、图片送进当前输入区 |
| `ThreadSettingsFields` | 唯一的设置表单控件：`value` 进、`onChange` 出，默认值与模型目录由它自己从 Provider 读取 |
| `ThreadSettingsPopover` / `ThreadSettingsButton` | 上面那个控件的弹出外壳，以及只给 `threadId` 就能用的开箱按钮 |
| `ThreadSettings` / `ReasoningEffort` / `REASONING_EFFORTS` | 设置 schema 与推理强度档位 |
| `threadSettingsFromThread` / `threadSettingsFromDefaults` / `threadSettingsForNewThread` | 从线程行、账号默认、新建草稿构造这个值 |
| `threadSettingsDefaults` / `sameThreadSettings` / `budgetTooLarge` | 生成默认设置的 PUT 负载、比较两个值、判断金额是否超上限 |

`Thread`、`ThreadDefaults`、`HistoryRecord`、`ThreadHistoryWindow`、`ThreadResponseView`、`ThreadUsage`、`ThreadDisplayStatus`、`ThreadManualLoadsView`、`ManualSummary`、`Worker`、`Language`、`ComposerFile`、`SkippedFile` 等是这些组件收发的数据形状。

### `/logic`

宿主自己写列表、状态行、输入区时需要的那部分，不含任何组件与样式表：

| 主题 | 提供 |
| --- | --- |
| 线程设置 | 与主入口同一套 schema 读取与写入函数 |
| 历史与状态 | `newestRecordId`、`oldestRecordId`、`historyPayloadObject`、`historyPayloadText`、`pendingResponseRecords`、`threadStatusLabel`、`threadStatusText`、`manualLoadNotice`、`emptyThreadUsage` |
| 输入区 | `composerAction`、`handleChatInputKeyDown`、`composerDraftKey`、`composeComposerInput`、`maxInputChars`、`audioDraftScope`、`useComposerAttach` / `useComposerAudio` / `useComposerDraft` / `useComposerFiles` / `useComposerImages`、`attachComposerAudio`、`attachComposerImages` |
| 展示 | `formatBytes`、`formatRelativeTime`、`formatStatsDuration`、`formattedTime`、`useNowSeconds`、`cn`、`errorMessage` |

### 包内部

记录卡片（每张工具卡一张）、底层 API 客户端、文案表、滚动容器原语、转录分组与轮询都属于实现：只有包自己会把它们拼起来，所以它们不进公开面，签名可以随时改。`@zccz14/cybion-components/internal` 与 `/internal-logic` 是**仓库内**测试与走查页的入口，明确不属于公开契约。

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
