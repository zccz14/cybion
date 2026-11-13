import { useCallback } from "react"

import { splitPickedFiles } from "../lib/composer-files"
import type { useComposerAudio } from "./use-composer-audio"
import type { useComposerFiles } from "./use-composer-files"
import type { useComposerImages } from "./use-composer-images"

/// 附件按钮选完文件之后的分流：图片走图片，音频走语音，文本走文件，剩下的原样
/// 变成“未添加”的理由。两个 composer 共用这一份，谁都不再自己判断类型。
export function useComposerAttach({
  images,
  audio,
  files,
}: {
  images: ReturnType<typeof useComposerImages>
  audio: ReturnType<typeof useComposerAudio>
  files: ReturnType<typeof useComposerFiles>
}) {
  return useCallback((picked: File[]) => {
    const routed = splitPickedFiles(picked)
    if (routed.images.length > 0) void images.add(routed.images)
    if (routed.audios.length > 0) void audio.add(routed.audios)
    void files.add(routed.texts, routed.unsupported)
  }, [images, audio, files])
}
