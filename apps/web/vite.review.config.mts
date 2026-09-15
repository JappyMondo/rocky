import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: import.meta.dirname,
  base: '/review-assets/',
  plugins: [react()],
  define: { __ROCKY_VERSION__: JSON.stringify('0.2.0') },
  build: {
    outDir: 'dist/review',
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'review.html') },
  },
});
