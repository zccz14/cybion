import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'assets/app.css' : 'assets/[name][extname]',
      },
    },
  },
});
