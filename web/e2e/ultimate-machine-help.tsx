import { useState } from "react"
import { createRoot } from "react-dom/client"
import { UltimateMachineHelp } from "../src/components/ultimate-machine-help"
import "../src/styles.css"

function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("zh")
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <UltimateMachineHelp language={language} />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
