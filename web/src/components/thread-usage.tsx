import { ChevronDownIcon } from "lucide-react"
import { compactTokenCount, threadCacheRate, type ThreadUsage } from "@/lib/thread-usage"

type Props = { usage: ThreadUsage; language: "en" | "zh" }
const copy = {
  zh: {
    total: "累计 Token", input: "输入 Token", output: "输出 Token", cached: "已回报的缓存 Token", cache: "缓存率", shortCache: "缓存",
    scope: "累计本线程全部请求已回报的输入与输出用量，包含推理、压缩和标题生成。缓存 Token 属于输入，不重复计入总量；缓存率按缓存输入 ÷ 输入总量计算。未回报用量不估算。",
    unknownCache: "无输入用量或缓存信息不完整时，缓存率显示 —。",
    incomplete: "用量未完整回报的请求", incompleteShort: "用量不完整",
  },
  en: {
    total: "Total tokens", input: "Input tokens", output: "Output tokens", cached: "Reported cached tokens", cache: "Cache rate", shortCache: "Cache",
    scope: "Adds reported input and output usage across all requests in this thread, including inference, compaction and title generation. Cached tokens are part of input, not added again. Cache rate = cached input ÷ total input. Unreported usage is not estimated.",
    unknownCache: "Cache rate is — when input is zero or cache details are incomplete.",
    incomplete: "Requests with incomplete usage", incompleteShort: "Partial usage",
  },
} as const

export function ThreadUsageSummary({ usage, language }: Props) {
  const t = copy[language]
  return <span data-slot="thread-usage-summary" className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground" aria-label={`${t.total}: ${usage.total_tokens.toLocaleString(language)}; ${t.cache}: ${threadCacheRate(usage.cache_hit_rate, language)}`}>
    <span className="whitespace-nowrap">{compactTokenCount(usage.total_tokens)} tokens</span>
    <span className="whitespace-nowrap">{t.shortCache} {threadCacheRate(usage.cache_hit_rate, language)}</span>
    {usage.unreported_requests > 0 && <span>{t.incompleteShort}</span>}
  </span>
}

export function ThreadUsageDetails({ usage, language }: Props) {
  const t = copy[language]
  const number = (value: number) => value.toLocaleString(language === "zh" ? "zh-CN" : "en")
  const rows = [[t.total, number(usage.total_tokens)], [t.input, number(usage.input_tokens)], [t.output, number(usage.output_tokens)], [t.cached, number(usage.cached_tokens)], [t.cache, threadCacheRate(usage.cache_hit_rate, language)]]
  return <div data-slot="thread-usage-details" className="flex min-w-0 flex-col gap-2 text-xs">
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">{rows.map(([label, value]) => <div key={label} className="contents"><dt>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl>
    {usage.unreported_requests > 0 && <p>{t.incomplete}: {number(usage.unreported_requests)}</p>}
    <p className="leading-5">{t.scope}</p><p className="leading-5">{t.unknownCache}</p>
  </div>
}

export function ThreadUsagePanel({ usage, language }: Props) {
  const t = copy[language]
  return <details data-slot="thread-usage-panel" className="group border-b px-4 py-2 text-xs text-muted-foreground">
    <summary className="flex w-fit max-w-full cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 rounded-sm focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span>{t.total} <strong className="font-medium tabular-nums text-foreground">{usage.total_tokens.toLocaleString(language)}</strong></span>
      <span>{t.cache} <strong className="font-medium tabular-nums text-foreground">{threadCacheRate(usage.cache_hit_rate, language)}</strong></span>
      {usage.unreported_requests > 0 && <span>{t.incompleteShort}</span>}
      <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="mt-3 max-w-xl"><ThreadUsageDetails usage={usage} language={language} /></div>
  </details>
}
