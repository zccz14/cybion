import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ComposerAudio } from "../../packages/cybion-components/src/components/composer-audio"
import { ComposerAudioNotice } from "../../packages/cybion-components/src/components/composer-audio-notice"
import { ComposerAttachments } from "../../packages/cybion-components/src/components/composer-attachments"
import { Textarea } from "../../packages/cybion-components/src/ui/textarea"
import "../src/styles.css"

const noop = () => undefined
const start = async () => true

/// 一个状态一张卡，卡片宽度就是输入框在手机/桌面上真实拿到的宽度。
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-2 rounded-lg border p-3">
    <p className="text-xs font-medium text-muted-foreground">{title}</p>
    <Textarea placeholder="继续描述你的需求…" rows={2} readOnly />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">压缩</span>
      <div className="flex flex-wrap items-center gap-2">
        {children}
      </div>
    </div>
  </section>
}

function States() {
  return <div className="mx-auto flex max-w-md flex-col gap-4 p-4" data-testid="states">
    <Card title="idle">
      <ComposerAudio language="zh" recording={false} phase="idle" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="starting（等麦克风）">
      <ComposerAudio language="zh" recording={false} phase="starting" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="recording 0:42">
      <ComposerAudio language="zh" recording phase="recording" elapsed={42} disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="finalizing（收尾）">
      <ComposerAudio language="zh" recording={false} phase="finalizing" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="录音失败 + 附件">
      <ComposerAttachments language="zh" images={[]} audios={["data:audio/webm;base64,AAAA"]} onRemove={noop} onRemoveAudio={noop} />
      <ComposerAudioNotice language="zh" error="empty" onDismiss={noop} />
      <ComposerAudio language="zh" recording={false} phase="idle" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="草稿恢复（2 段未发）">
      <ComposerAttachments language="zh" images={[]} audios={["data:audio/webm;base64,AAAA", "data:audio/webm;base64,BBBB"]} onRemove={noop} onRemoveAudio={noop} />
      <ComposerAudioNotice language="zh" error={null} restored={2} onRetry={noop} onDismissRestored={noop} />
      <ComposerAudio language="zh" recording={false} phase="idle" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
    <Card title="权限被拒（长文案）">
      <ComposerAudioNotice language="zh" error="too-large" onDismiss={noop} />
      <ComposerAudio language="zh" recording={false} phase="idle" disabled={false} onStart={start} onSend={noop} onCancel={noop} />
    </Card>
  </div>
}

createRoot(document.getElementById("root")!).render(<StrictMode><States /></StrictMode>)
