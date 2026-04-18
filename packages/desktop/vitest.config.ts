import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { shipperCoreTextAssetsPlugin } from '../../vitest.shipper-core-text-assets.js';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [shipperCoreTextAssetsPlugin()],
  resolve: {
    alias: {
      '@dnsquared/shipper-core': path.resolve(packageRoot, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', 'out/', '**/*.config.*', '**/*.test.{ts,tsx}'],
      thresholds: {
        lines: 17,
        branches: 63,
        functions: 42,
        statements: 17,
      },
    },
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'out', 'release'],
  },
});
