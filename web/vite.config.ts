import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  // 插件把同一份 dist 装进侧边栏：相对基址让 chrome-extension:// 下也能加载资源。
  base: './',
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
      // 仓库内的走查页与单测要渲染包内并不对外导出的记录卡片（每张卡片各自一条
      // 回归用例）。它们不是包的消费者，所以走源码而不是公开入口：公开面收窄
      // 的时候，这些测试不必跟着改，也不会反过来把内部实现钉成契约。
      '@zccz14/cybion-components/src': path.resolve(__dirname, '../packages/cybion-components/src'),
      '@zccz14/cybion-components/internal': path.resolve(__dirname, '../packages/cybion-components/dist/internal.js'),
      '@zccz14/cybion-components/logic': path.resolve(__dirname, '../packages/cybion-components/dist/logic.js'),
      '@zccz14/cybion-components': path.resolve(__dirname, '../packages/cybion-components/dist/index.js'),
    },
    dedupe: ['@tanstack/react-query', 'react', 'react-dom', '@zccz14/ux', '@shadcn/react', 'lucide-react', 'radix-ui', '@base-ui/react', 'embla-carousel-react', 'class-variance-authority', 'clsx', 'tailwind-merge'],
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
