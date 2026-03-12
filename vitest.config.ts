import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dnsquared/shipper-core': path.resolve(repoRoot, 'packages/core/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['packages/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
