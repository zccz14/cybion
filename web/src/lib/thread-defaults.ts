// 保存按钮的启用条件是「草稿和已保存的默认值不同」。曾经这里逐字段手写比较，
// 结果新增 audio_transcription_model 时漏了一行——只改语音识别模型时按钮永远
// 是禁用的，用户看到的就是「改了不能保存」。比较服务端返回的每一个字段，新增
// 设置项就不会再被漏掉。
export function defaultsChanged(current: Record<string, unknown>, saved: Record<string, unknown>): boolean {
  return Object.keys(current).some((key) => current[key] !== saved[key])
}
