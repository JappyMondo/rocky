import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  define: { __ROCKY_VERSION__: JSON.stringify('0.0.0') },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test-output/vitest/coverage',
      reporter: ['text-summary', 'html', 'json-summary'],
      // Without this, v8 only reports files a test happens to import, so a new
      // untested file would land without moving the number the gate watches.
      include: ['src/**/*.{ts,tsx}'],
      // The browser bootstrap: it mounts a real DOM root and renders `App`,
      // which is itself covered.
      exclude: ['src/main.tsx', 'src/**/*.d.ts'],
      // Pin the measured redesign suite so coverage cannot silently regress.
      thresholds: {
        statements: 93.55,
        branches: 85.09,
        functions: 93.77,
        lines: 94.51,
      },
    },
  },
});
