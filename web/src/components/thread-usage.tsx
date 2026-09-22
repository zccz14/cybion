import { ChevronDownIcon } from "lucide-react"
import { compactTokenCount, threadCacheRate, type ThreadUsage } from "@/lib/thread-usage"

type Props = { usage: ThreadUsage; language: "en" | "zh" }
const copy = {
  zh: {
    total: "累计 Token", input: "输入 Token", output: "输出 Token", cached: "缓存 Token", cache: "缓存率", shortCache: "缓存",
    scope: "累计本线程审计记录中的输入与输出用量，包含推理、压缩和标题生成。缓存 Token 属于输入，不重复计入总量；缓存率按缓存输入 ÷ 输入总量计算。",
    context: "上下文", contextOff: "自动压缩关闭",
    contextScope: "最近一次推理请求实际送出的输入 Token，与自动压缩预算（超过后压缩为 checkpoint）。",
  },
  en: {
    total: "Total tokens", input: "Input tokens", output: "Output tokens", cached: "Cached tokens", cache: "Cache rate", shortCache: "Cache",
    scope: "Adds input and output usage from this thread's audit records, including inference, compaction and title generation. Cached tokens are part of input, not added again. Cache rate = cached input ÷ total input.",
    context: "Context", contextOff: "auto-compaction off",
    contextScope: "Input tokens of the most recent inference request, against the automatic compaction budget (compacts into a checkpoint once exceeded).",
  },
} as const

export function ThreadUsageSummary({ usage, language }: Props) {
  const t = copy[language]
  return <span data-slot="thread-usage-summary" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground" aria-label={`${t.total}: ${usage.total_tokens.toLocaleString(language)}; ${t.cache}: ${threadCacheRate(usage.cache_hit_rate, language)}`}>
    <span className="whitespace-nowrap">{compactTokenCount(usage.total_tokens)} tokens</span>
    <span className="whitespace-nowrap">{t.shortCache} {threadCacheRate(usage.cache_hit_rate, language)}</span>
  </span>
}

export function ThreadUsageDetails({ usage, language }: Props) {
  const t = copy[language]
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  const rows = [[t.total, number(usage.total_tokens)], [t.input, number(usage.input_tokens)], [t.output, number(usage.output_tokens)], [t.cached, number(usage.cached_tokens)], [t.cache, threadCacheRate(usage.cache_hit_rate, language)]]
  return <div data-slot="thread-usage-details" className="flex min-w-0 flex-col gap-2 text-xs">
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">{rows.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl>
    <p className="leading-5">{t.scope}</p>
  </div>
}

export function ThreadUsagePanel({ usage, language }: Props) {
  const t = copy[language]
  return <details data-slot="thread-usage-panel" className="group border-b px-4 py-2 text-xs text-muted-foreground">
    <summary className="flex w-fit max-w-full cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span>{t.total} <strong className="font-medium tabular-nums text-foreground">{usage.total_tokens.toLocaleString(language)}</strong></span>
      <span>{t.cache} <strong className="font-medium tabular-nums text-foreground">{threadCacheRate(usage.cache_hit_rate, language)}</strong></span>
      <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="mt-3 max-w-xl"><ThreadUsageDetails usage={usage} language={language} /></div>
  </details>
}

export function ThreadContextUsage({ context, language }: { context: { tokens: number | null; budget: number }; language: "en" | "zh" }) {
  const t = copy[language]
  const tokens = context.tokens === null ? "—" : compactTokenCount(context.tokens)
  const budget = context.budget > 0 ? compactTokenCount(context.budget) : t.contextOff
  const over = context.tokens !== null && context.budget > 0 && context.tokens >= context.budget
  return <span data-slot="thread-context-usage" title={t.contextScope} className={`whitespace-nowrap text-xs tabular-nums ${over ? "text-destructive" : "text-muted-foreground"}`}>
    {t.context} <strong className="font-medium">{tokens}</strong> / {budget}
  </span>
}
