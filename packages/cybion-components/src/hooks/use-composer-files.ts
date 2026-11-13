import { useCallback, useRef, useState } from "react"

import {
  composerFileChars, isTextPickedFile, maxComposerChars, maxComposerFileBytes, maxComposerFiles,
  minComposerFileChars, readComposerFile, type ComposerFile, type SkippedFile,
} from "../lib/composer-files"

/// Text attachments of one composer: files picked through the attachment button
/// that travel inside the message as text, plus the reason each refused file was
/// refused. Images and audio keep their own hooks; `splitPickedFiles` decides who
/// gets what.
export function useComposerFiles(): {
  files: ComposerFile[]
  skipped: SkippedFile[]
  /// Reads what fits and records the rest as skipped; a file is refused only when
  /// sending it would be worse than not sending it (wrong type, too big, no room).
  add: (picked: File[], unsupported?: string[]) => Promise<void>
  remove: (index: number) => void
  clear: () => void
} {
  const [files, setFiles] = useState<ComposerFile[]>([])
  const [skipped, setSkipped] = useState<SkippedFile[]>([])
  // INVARIANT: picks run one after another, so the budget is read from the same
  // state the next pick appends to instead of from a stale render.
  const latest = useRef<ComposerFile[]>([])
  const add = useCallback(async (picked: File[], unsupported: string[] = []) => {
    const refused: SkippedFile[] = unsupported.map((name) => ({ name, reason: "type" }))
    const accepted: ComposerFile[] = []
    for (const file of picked) {
      if (!isTextPickedFile(file)) {
        refused.push({ name: file.name, reason: "type" })
        continue
      }
      if (latest.current.length + accepted.length >= maxComposerFiles) {
        refused.push({ name: file.name, reason: "count" })
        continue
      }
      if (file.size > maxComposerFileBytes) {
        refused.push({ name: file.name, reason: "size" })
        continue
      }
      const used = composerFileChars(latest.current) + composerFileChars(accepted)
      const room = maxComposerChars - used
      if (room < minComposerFileChars) {
        refused.push({ name: file.name, reason: "room" })
        continue
      }
      const read = await readComposerFile(file, room)
      if (read === null) {
        refused.push({ name: file.name, reason: "type" })
        continue
      }
      accepted.push(read)
    }
    if (accepted.length > 0) {
      latest.current = [...latest.current, ...accepted]
      setFiles(latest.current)
    }
    setSkipped(refused)
  }, [])
  const remove = useCallback((index: number) => {
    latest.current = latest.current.filter((_, currentIndex) => currentIndex !== index)
    setFiles(latest.current)
  }, [])
  const clear = useCallback(() => {
    latest.current = []
    setFiles([])
    setSkipped([])
  }, [])
  return { files, skipped, add, remove, clear }
}
