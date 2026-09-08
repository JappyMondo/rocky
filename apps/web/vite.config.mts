import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  // The daemon serves these statics from its own root, so no base prefix.
  base: '/',
  plugins: [react()],
  define: {
    __ROCKY_VERSION__: JSON.stringify(
      JSON.parse(
        readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
      ).version,
    ),
  },
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
