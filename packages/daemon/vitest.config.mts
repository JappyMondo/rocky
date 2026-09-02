import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: '@rocky/daemon',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // The suite binds real ports, including the default 7625.
    fileParallelism: false,
    // These start a real server rather than injecting; on a cold run the
    // plugin load alone can outlast vitest's 5s default. The whole suite takes
    // ~2s warm even with coverage on, so this ceiling is headroom for a cold CI
    // runner, not a budget any test is expected to approach.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test-output/vitest/coverage',
      reporter: ['text-summary', 'html', 'json-summary'],
      // Without this, v8 only reports files a test happens to import, so a new
      // untested file would land without moving the number the gate watches.
      include: ['src/**/*.ts'],
       // Pinned just under the measured baseline, because this suite covers
      // slightly more on darwin than on the linux runner — a few `POSIX`
      // guards — so pinning a local reading exactly would fail every CI run.
      // The margin below is about two units of each metric. Measured on darwin
      // at 95.27 / 87.45 / 95.97 / 95.66 (571 statements, 311 branches, 149
      // functions, 553 lines). Raise them when coverage rises.
      thresholds: {
        statements: 94.9,
        branches: 86.8,
         functions: 95.3,
         lines: 95.3,
       },
    },
  },
});
