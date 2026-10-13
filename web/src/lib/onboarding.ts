import type { ThreadListFilters } from "./thread-search"

// A filtered empty result is not proof of a new workspace. Only these two
// unsearched entry views may request the separate, unfiltered count check.
export function needsFirstConversationCheck(filters: ThreadListFilters, visibleTotal: number | undefined, archivedTotal: number | undefined) {
  return (filters.view === "mine" || filters.view === "all") && filters.q.trim() === "" && visibleTotal === 0 && archivedTotal === 0
}

const en = {
  helpTitle: "Using Cybion", helpDescription: "Start a conversation, then add a context or connect a device when your task needs them.",
  threadTitle: "What is a conversation (Thread)?", threadSummary: "A conversation is a place to work on one task with Cybion. It keeps its own messages and execution history.",
  threadDetail: "Start a new conversation for a different task. Other conversations do not automatically share their histories; Contexts keep your material sources discoverable across tasks.",
  threadOptional: "You can start a normal conversation without adding Contexts or installing a Worker. A working model service is required; model usage may incur provider charges.",
  threadAction: "Start a conversation",
  contextTitle: "What is a Context?", contextSummary: "A Context is a lightweight Markdown document: what a source is for, where it lives, and how to read it. It is not the source material itself.",
  contextDetail: "Original material stays on a Worker device or a website. Cybion reads the instructions inside the Context, then accesses the sources as the task requires. Creating a Context does not load all its contents into every conversation.",
  contextBoundary: "Cybion stores what you enter here, not a hosted copy of the original library. Material retrieved for a task may still appear in that conversation's records.",
  contextAction: "Open Contexts",
  workerTitle: "What is a Worker?", workerSummary: "A Worker is the connection program running on your computer or server. It lets Cybion access that device's material and perform tasks there.",
  workerOptional: "Optional for normal conversation. Connect a device only when you need its files, commands, or available browser and desktop controls.",
  workerBoundary: "A Worker runs with its OS account's permissions; not every command asks for approval again. An offline device cannot provide its material. Online status alone does not verify all execution capabilities.",
  workerAction: "Connect a device",
  learnMore: "Open usage help", close: "Got it",
  welcomeTitle: "What would you like to get done?", welcomeDescription: "Describe your task below. Add contexts when Cybion should consult your material; connect a device when the task needs local access.",
  examplesHint: "Examples only fill your draft. Nothing is sent until you choose to send it.",
  planExample: "Turn an idea into a plan", planPrompt: "Help me turn the following idea into an actionable plan:\n\n",
  rewriteExample: "Improve a piece of writing", rewritePrompt: "Rewrite the following text to make it clearer:\n\n",
  useReference: "Use in a conversation", useReferenceHint: "Uses the saved context and fills an empty draft; it never overwrites an existing draft or sends automatically.",
  chatQuestion: "Where is the chat box?", chatAnswer: "Open My conversations and choose New conversation. A confirmed empty workspace opens the composer directly, including on a phone.",
  libraryQuestion: "Where is the library?", libraryAnswer: "Cybion does not host a separate original-material library. Your material stays on devices or network sources. Contexts is where you describe your material sources.",
  budgetQuestion: "Is Context budget the same as Contexts?", budgetAnswer: "No. Contexts record where your material lives and how to read it. Context budget controls how much conversation information the model replays before automatic compaction; it is not a storage quota for your contexts.",
  modelQuestion: "What if a message fails?", modelAnswer: "Read the error first. For model connection, authorization or quota errors, check Personal settings and the selected provider. Installing a Worker does not fix model-service errors. For device tasks, check the specific device's connection and permissions.",
  modelAction: "Check model settings", preparing: "Preparing the default model connection…", connectionFailed: "The default model connection could not be prepared.",
  connectionRecovery: "Retry the connection or check model settings. Existing configured upstreams can still be used; this notice does not block them.",
  retryConnection: "Retry connection", startFailed: "Could not start this conversation", retrySend: "Retry sending",
}
const zh: Record<keyof typeof en, string> = {
  helpTitle: "使用帮助", helpDescription: "先开始对话；任务需要资料或设备时，再添加上下文或连接设备。",
  threadTitle: "什么是对话（Thread）？", threadSummary: "对话是你与 Cybion 持续处理一件事的空间，会保留这段对话的消息和执行过程。",
  threadDetail: "处理另一件事时可以新建对话。不同对话不会自动共享历史；需要复用的资料来源，可以写进上下文。",
  threadOptional: "普通对话无需先添加上下文或安装 Worker。对话需要可用的模型服务，使用模型可能产生提供方收取的费用。",
  threadAction: "开始对话",
  contextTitle: "什么是上下文？", contextSummary: "上下文是一份轻量的 Markdown 文档：资料用于什么、在哪里、怎样获取。它不是资料本体。",
  contextDetail: "原始资料留在 Worker 设备或网站中。Cybion 先读取上下文里的说明，再根据任务需要访问来源。创建上下文，不等于把全部资料自动放进每一段对话。",
  contextBoundary: "Cybion 保存你填写的上下文内容，而非托管一份原始资料库。为任务读取的内容仍可能进入对应的对话记录。",
  contextAction: "打开上下文",
  workerTitle: "什么是 Worker？", workerSummary: "Worker 是运行在你的电脑或服务器上的连接程序，让 Cybion 能访问那台设备上的资料，并在设备上执行任务。",
  workerOptional: "普通对话不需要 Worker。需要读取设备文件、执行命令或使用可用的浏览器与桌面操作能力时，再连接设备。",
  workerBoundary: "Worker 按运行账户的系统权限执行，并非每条命令都会再次请求确认。设备离线时无法读取其资料；在线也不等于所有执行能力都已验证。",
  workerAction: "连接设备",
  learnMore: "查看使用帮助", close: "知道了",
  welcomeTitle: "你想让 Cybion 帮你完成什么？", welcomeDescription: "在下方直接描述需求。需要查阅资料时，添加上下文；需要操作电脑时，再连接设备。",
  examplesHint: "示例只填入草稿，由你确认发送，不会自动发起模型请求。",
  planExample: "把想法整理成计划", planPrompt: "帮我把下面的想法整理成可执行的计划：\n\n",
  rewriteExample: "让表达更清楚", rewritePrompt: "帮我改写下面这段文字，让表达更清楚：\n\n",
  useReference: "在对话中使用", useReferenceHint: "使用已保存的上下文填入空白草稿；不会覆盖已有草稿，也不会自动发送。",
  chatQuestion: "对话框在哪里？", chatAnswer: "打开「我的对话」，点击「新建对话」。确认没有任何对话的工作区会直接显示输入框，手机也一样。",
  libraryQuestion: "资料库在哪里？", libraryAnswer: "Cybion 不托管独立的原始资料库。资料保存在设备或网络来源中；「上下文」用于记录资料在哪里。",
  budgetQuestion: "上下文预算和这里的上下文是一回事吗？", budgetAnswer: "不是。这里的上下文记录资料在哪里、怎样获取；上下文预算限制模型重放的对话信息量，超过后可自动压缩，并不是上下文的存储空间配额。",
  modelQuestion: "发送失败怎么办？", modelAnswer: "先查看错误信息。模型连接、授权或额度有问题时，检查「个人配置」和所选模型提供方；安装 Worker 不能解决模型服务错误。设备任务失败时，检查对应设备的连接和权限。",
  modelAction: "检查模型设置", preparing: "正在准备默认模型连接…", connectionFailed: "默认模型连接未能准备完成。",
  connectionRecovery: "可以重试连接，或检查模型设置。已配置的其他上游仍可使用，此提示不会阻止它们。",
  retryConnection: "重试连接", startFailed: "未能开始这段对话", retrySend: "重试发送",
}
export const onboardingCopy = { en, zh }
export type OnboardingLanguage = keyof typeof onboardingCopy
export function contextReferencePrompt(language: OnboardingLanguage, name: string, id: string) {
  return language === "zh"
    ? `请先列出我的上下文，找到「${name}」（context_id: ${id}）并阅读它的内容。根据任务需要访问其中的资料来源，不要一次性加载全部资料。\n\n我的任务：`
    : `List my Contexts, find “${name}” (context_id: ${id}), and read its content. Access the source material as this task requires rather than loading everything at once.\n\nMy task: `
}
