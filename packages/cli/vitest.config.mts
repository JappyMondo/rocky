import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'rocky',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test-output/vitest/coverage',
      reporter: ['text-summary', 'html', 'json-summary'],
      // Without this, v8 only reports files a test happens to import, so a new
      // untested file would land without moving the number the gate watches.
      include: ['src/**/*.ts'],
      // The `#!/usr/bin/env node` shim: it only runs as a real process, and
      // everything it calls is covered through `cli.ts`.
      exclude: ['src/main.ts'],
      // Pinned to the measured baseline: vitest fails the run on any drop, so
      // the gate is the same locally as in CI. Raise these when coverage rises.
      //
      // Raised by NG-600, which measured 94.02 / 81.7 / 81.57 / 94.5. Held half
      // a point under that, for the same platform reason the daemon's config
      // spells out.
      thresholds: {
        statements: 93.4,
        branches: 81,
        functions: 81,
        lines: 94,
      },
    },
  },
});
