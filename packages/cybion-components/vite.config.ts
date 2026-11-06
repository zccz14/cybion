import { defineConfig } from "vitest/config";

// Everything the host already owns stays external so the package never ships a
// second copy of React, the Markdown surface, or the UI runtime.
const externalPackages = [
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
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    rollupOptions: {
      external: (id) => externalPackages.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
  test: {
    environment: "jsdom",
  },
});
