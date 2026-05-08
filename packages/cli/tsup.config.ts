import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts', 'src/ship-worker.ts', 'src/scripts/check-init-drift.ts'],
  noExternal: ['@baremetallabs-ai/shipper-core'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  loader: {
    '.md': 'text',
    '.sh': 'text',
  },
  shims: true,
  minify: false,
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    'process.env.SHIPPER_VERSION': JSON.stringify(pkg.version),
  },
});
