import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
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
      // Pinned to the measured baseline: vitest fails the run on any drop, so
      // the gate is the same locally as in CI. Raise these when coverage rises.
      //
      // Raised by NG-600. The shell is small enough that one uncovered
      // statement moves the number by several points, so these are the exact
      // reading rather than a rounded one — there is no sub-point drift to
      // absorb.
      thresholds: {
        statements: 100,
        branches: 82.35,
        functions: 100,
        lines: 100,
      },
    },
  },
});
