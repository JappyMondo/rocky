import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'rocky',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // `daemon-control.spec.ts` spawns real detached daemons and binds real
    // ports, which is the only honest way to test `start -d` and `stop`.
    fileParallelism: false,
    testTimeout: 20_000,
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
       // Pinned just under the measured baseline: vitest fails the run on any
      // drop, so the gate is the same locally as in CI, and the small margin
      // absorbs the platform difference the daemon's config describes.
      // Measured on darwin at 86.74 / 83.18 / 83.07 / 87.53 (347 statements,
      // 226 branches, 65 functions, 337 lines). Raise these when coverage
      // rises.
      thresholds: {
        statements: 86.1,
        branches: 82.2,
         functions: 81.4,
         lines: 86.9,
       },
    },
  },
});
