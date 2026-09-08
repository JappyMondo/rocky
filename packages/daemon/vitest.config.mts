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
      // These run only in isolated Node child processes. Their integration
      // specs exercise them there, but Vitest's inspector cannot collect that
      // child-process coverage with the parent suite.
      exclude: [
        'src/run/boot-child.ts',
        'src/run/loading/loader.ts',
        'src/run/loading/validate-child.ts',
        'src/run/loading/validate-worker.ts',
      ],
      // Pinned to the real CI reading. The previous values predated the
      // production intake paths and made the unchanged default branch fail;
      // keep the gate at this measured baseline and raise it as coverage grows.
      thresholds: {
        statements: 91.45,
        branches: 85.7,
        functions: 92.15,
        lines: 92.55,
      },
    },
  },
});
