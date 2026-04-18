import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const textAssetPattern = /\.(md|sh)$/;

export default defineConfig({
  plugins: [
    {
      name: 'shipper-core-text-assets',
      async load(id) {
        if (!textAssetPattern.test(id)) {
          return null;
        }

        const source = await readFile(id, 'utf8');
        return `export default ${JSON.stringify(source)};`;
      },
    },
  ],
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
      exclude: ['node_modules/', 'dist/', '**/*.config.*', '**/*.test.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 86,
        statements: 80,
      },
    },
    include: ['**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
