import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    entries: ['index.html', 'e2e/*.html'],
    include: ['@shadcn/react/message-scroller'],
  },
  // @zccz14/ux 的渲染器为副作用引入 KaTeX 的样式表。Vite 的 SSR 默认外置 node_modules，
  // 那样这行导入会交给 Node 的加载器，而 Node 不认识 .css——单元测试（ssrLoadModule）会因此报
  // ERR_UNKNOWN_FILE_EXTENSION。把该包内联，样式表仍然走 Vite 的 CSS 管线。
  ssr: { noExternal: ['@zccz14/ux'] },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app-[hash].js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'assets/app-[hash].css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
