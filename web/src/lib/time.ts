export function formattedTime(language: "en" | "zh", value: number | null | undefined) {
  if (value == null) return "—"
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(value * 1000)
}
