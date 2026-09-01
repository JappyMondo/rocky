import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  // The daemon serves these statics from its own root, so no base prefix.
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
  },
  server: {
    port: 4200,
    // In `nx dev web`, the API still comes from the daemon's port.
    proxy: {
      '/api': 'http://127.0.0.1:7625',
    },
  },
});
