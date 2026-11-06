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
  // 组件包就在同一个仓库里：宿主直接消费包自己的构建产物，与 Tickets 从 npm 拿到的东西
  // 完全一致；包内的 react 等运行时去重到宿主这一份，避免第二份 React。
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@zccz14/cybion-components': path.resolve(__dirname, '../packages/cybion-components/dist/index.js'),
    },
    dedupe: ['react', 'react-dom', '@zccz14/ux', 'lucide-react', 'radix-ui', '@base-ui/react', 'clsx', 'tailwind-merge'],
  },
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
