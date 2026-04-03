import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/*.test.ts'],
      thresholds: {
        lines: 80,
        branches: 81,
        functions: 86,
        statements: 80,
      },
    },
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
