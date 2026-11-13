import type { SkippedFile } from "../lib/composer-files"

const copy = {
  en: {
    prefix: "Not attached:",
    type: "not an image, audio, or text file",
    size: "over 2 MB",
    count: "over 8 files per message",
    room: "no room left in this message",
  },
  zh: {
    prefix: "未添加：",
    type: "不是图片、音频或文本文件",
    size: "超过 2 MB",
    count: "每条消息最多 8 个",
    room: "这条消息已经放不下",
  },
} as const

/// 被拒的文件必须说话：静默丢弃会让用户以为传上去了。按原因分组，一个原因一句。
export function ComposerFileNotice({ language, skipped }: { language: "en" | "zh"; skipped: SkippedFile[] }) {
  if (skipped.length === 0) return null
  const t = copy[language]
  const reasons = Array.from(new Set(skipped.map((file) => file.reason)))
  return <ul role="status" className="flex flex-col gap-0.5 text-xs text-destructive">
    {reasons.map((reason) => <li key={reason}>
      {t.prefix} {skipped.filter((file) => file.reason === reason).map((file) => file.name).join("、")}（{t[reason]}）
    </li>)}
  </ul>
}

/// 附件加上正文也不会无限长：Controller 只收一定长度的输入，超了就在这里说清楚，
/// 而不是等提交后回一条 400。
export function ComposerLengthNotice({ language, chars, limit }: { language: "en" | "zh"; chars: number; limit: number }) {
  return <p role="status" className="text-xs text-destructive">
    {language === "zh"
      ? `正文和附件共 ${chars} 字符，超过 ${limit} 字符上限，请去掉一部分附件。`
      : `Text and attachments reach ${chars} characters; the limit is ${limit}. Remove an attachment.`}
  </p>
}
