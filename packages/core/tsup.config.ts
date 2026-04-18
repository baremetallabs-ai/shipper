import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/internal.ts', 'src/lib/**/*.ts', 'src/templates/readme.js'],
  format: ['esm'],
  dts: true,
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
});
