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
    // plugin load alone can outlast vitest's 5s default.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'test-output/vitest/coverage',
    },
  },
});
