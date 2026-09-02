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
       // Pinned to the baseline measured *on the CI runner*, for the reason
      // the daemon's config spells out: this suite covers one branch more on
      // darwin than on linux (187/226 there), so a local reading would fail
      // every CI run. Raise these when coverage rises.
      thresholds: {
        statements: 86.74,
        branches: 82.74,
         functions: 83.07,
         lines: 87.53,
       },
    },
  },
});
