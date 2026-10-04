import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { UserInputMessage } from "../src/components/user-input-message"
import { Message, MessageContent } from "../src/components/ui/message"
import "../src/styles.css"

function tinyPng() {
  const canvas = document.createElement("canvas")
  canvas.width = 4
  canvas.height = 4
  const context = canvas.getContext("2d")!
  context.fillStyle = "#3366cc"
  context.fillRect(0, 0, 4, 4)
  return canvas.toDataURL("image/png")
}
const png = tinyPng()

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
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
