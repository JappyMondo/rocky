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
      // Pinned to the baseline measured *on the CI runner*, which is the
      // platform of record: this suite covers one statement, branch and line
      // more on darwin than on the linux runner (327/348 against 326/348), so
      // pinning a local reading would fail every CI run. A local run therefore
      // sits at or above these numbers. Raise them when coverage rises.
      //
      // Raised by NG-600, which measured 96.09 / 88.62 / 96.38 / 96.48 on
      // darwin. Each number below is that reading less about half a point, so
      // the one-unit darwin/linux gap above cannot fail an honest run — the
      // margin is for the platform, not for slack.
      thresholds: {
        statements: 95.5,
        branches: 88,
        functions: 95.83,
        lines: 96,
      },
    },
  },
});
