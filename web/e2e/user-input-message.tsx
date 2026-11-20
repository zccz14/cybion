import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import { Message, MessageContent } from "../src/components/ui/message"
import "../src/styles.css"
import { UserInputMessage } from "@zccz14/cybion-components/internal"

function tinyPng() {
  const canvas = document.createElement("canvas")
  canvas.width = 4
  canvas.height = 4
  const manual = canvas.getContext("2d")!
  manual.fillStyle = "#3366cc"
  manual.fillRect(0, 0, 4, 4)
  return canvas.toDataURL("image/png")
}
const png = tinyPng()

// 一条塞满长句、长路径和一行完全不换行的环境变量的输入。断行坏掉时这个气泡会比
// 对话栏还宽，右对齐之后左半边被裁掉——手机上看到的就是行首缺字的文本。
const longInput = `请把 DeepSeek-LB 迁成 NormAI 仓内的开源插件 \`plugins/deepseek\`，先读 \`~/Projects/NormAI/crates/normai-plugin-sdk/src/*.rs\` 与 \`docs/plugin-interface.md\`。**接口是 1.0，含管理平台。**

然后 https://github.com/zccz14/NormAI/pull/1234567890abcdef1234567890abcdef12345678 这个 PR 的 diff 也要看，特别注意 \`crates/normai-plugin-sdk/src/lib.rs::PluginInterfaceVersion::parse_from_env_or_default_unchecked\`。

最后一个超长行（完全不换行）：DEEPSEEK_LB_UPSTREAM_BASE_URL=https://deepseek-internal-lb.us-east-1.ntnl.internal:8443/v1/chat/completions?model=deepseek-v4.1-flash&reasoning=max&session=0123456789abcdef0123456789abcdef`

const longTranscript = `这段转写没有标点也没有空格可以借助其中夹着 https://deepseek-internal-lb.us-east-1.ntnl.internal:8443/v1/chat/completions?model=deepseek-v4.1-flash 这样的地址以及 DEEPSEEK_LB_UPSTREAM_BASE_URL 这种不该把字幕撑宽的名字`
const audioNote = `[audio attachment ref=${"0123456789abcdef".repeat(4)} type=audio/webm] provisional transcript (whisper-1):\n${longTranscript}\nCall normai_audio_transcription`

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-5">
    <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
    <Message align="end"><MessageContent>
      <UserInputMessage language={language} payload={{ role: "user", content: "看看这张图。" }} footer="#12 · 2026-01-02 12:34:56" />
    </MessageContent></Message>
    <Message align="end"><MessageContent>
      <UserInputMessage language={language} payload={{ role: "user", content: [
        { type: "input_text", text: "这个报错怎么回事？" },
        { type: "input_image", image_url: png },
        { type: "input_image", image_url: png },
      ] }} footer="#13 · 2026-01-02 12:34:56" />
    </MessageContent></Message>
    <Message align="end"><MessageContent>
      <UserInputMessage language={language} payload={{ role: "user", content: [{ type: "input_image", image_url: png }] }} footer="#14 · 2026-01-02 12:34:56" />
    </MessageContent></Message>
    <Message align="end"><MessageContent>
      <UserInputMessage language={language} payload={{ role: "user", content: longInput }} footer="#15 · 2026-01-02 12:34:56" />
    </MessageContent></Message>
    <Message align="end"><MessageContent>
      <UserInputMessage language={language} payload={{ role: "user", content: [
        { type: "input_audio", audio_url: "data:audio/webm;base64,AAAA", media_type: "audio/webm", provisional_note: audioNote },
      ] }} footer="#16 · 2026-01-02 12:34:56" />
    </MessageContent></Message>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
