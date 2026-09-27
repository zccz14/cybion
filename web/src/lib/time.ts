export function formattedTime(language: "en" | "zh", value: number | null | undefined) {
  if (value == null) return "—"
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(value * 1000)
}

export function formatStatsDuration(seconds: number, language: "en" | "zh") {
  const safe = Math.max(0, seconds)
  const total = Math.floor(safe)
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  const remainder = total % 60
  const zh = language === "zh"
  if (days > 0) return zh ? `${days} 天${hours > 0 ? ` ${hours} 小时` : ""}` : `${days}d${hours > 0 ? ` ${hours}h` : ""}`
  if (hours > 0) return zh ? `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ""}` : `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
  if (minutes > 0) return zh ? `${minutes} 分钟${remainder > 0 ? ` ${remainder} 秒` : ""}` : `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`
  const value = safe < 10 ? Number(safe.toFixed(1)) : Math.round(safe)
  return zh ? `${value} 秒` : `${value}s`
}
