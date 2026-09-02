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
      // The rebase adds main's endpoint surface to this project, lowering its
      // branch baseline. Linux covers slightly fewer branches than darwin, so
      // retain the measured cross-platform margin below the local reading.
      thresholds: {
        statements: 86.74,
        branches: 81.4,
        functions: 83.07,
        lines: 87.53,
      },
    },
  },
});
