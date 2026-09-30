import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { ScreenshotOutput } from "../src/components/screenshot-output"
import "../src/styles.css"

function tinyPng() {
  const canvas = document.createElement("canvas")
  canvas.width = 8
  canvas.height = 6
  const context = canvas.getContext("2d")!
  context.fillStyle = "#3366cc"
  context.fillRect(0, 0, 8, 6)
  return canvas.toDataURL("image/png")
}
const png = tinyPng()

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex flex-col gap-4 p-5">
    <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
    <ScreenshotOutput language={language} source={png} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
