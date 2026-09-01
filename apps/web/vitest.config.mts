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
    },
  },
});
