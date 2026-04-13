import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@dnsquared/shipper-core': path.resolve(packageRoot, '../core/src/index.ts'),
    },
  },
  assetsInclude: ['**/*.md', '**/*.sh'],
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/*.test.ts'],
    },
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
