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
      // Pinned to the measured baseline: vitest fails the run on any drop, so
      // the gate is the same locally as in CI. Raise these when coverage rises.
      thresholds: {
        statements: 93.96,
        branches: 86.27,
        functions: 95.83,
        lines: 94.36,
      },
    },
  },
});
