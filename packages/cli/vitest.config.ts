import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { shipperCoreTextAssetsPlugin } from '../../vitest.shipper-core-text-assets.js';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [shipperCoreTextAssetsPlugin()],
  resolve: {
    alias: {
      '@baremetallabs-ai/shipper-core': path.resolve(packageRoot, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/*.test.ts'],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 86,
        statements: 80,
      },
    },
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
