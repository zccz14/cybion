import { defineConfig } from "vitest/config";

// Everything the host already owns stays external so the package never ships a
// second copy of React, the Markdown surface, or the UI runtime.
const externalPackages = [
  "@tanstack/react-query",
  "@base-ui/react",
  "@shadcn/react",
  "@zccz14/ux",
  "class-variance-authority",
  "clsx",
  "embla-carousel-react",
  "lucide-react",
  "radix-ui",
  "react",
  "react-dom",
  "tailwind-merge",
];

export default defineConfig({
  build: {
    lib: {
      entry: { index: "src/index.ts", logic: "src/logic.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: (id) => externalPackages.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
  test: {
    environment: "jsdom",
  },
});
