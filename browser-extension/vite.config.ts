import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const ui = fileURLToPath(new URL("./ui", import.meta.url))
const dist = fileURLToPath(new URL("./dist", import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: ui,
  base: "./",
  build: {
    outDir: dist,
    emptyOutDir: true,
    rollupOptions: { input: { sidepanel: fileURLToPath(new URL("./ui/sidepanel.html", import.meta.url)) } },
  },
})
