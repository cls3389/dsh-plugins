import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  dts: true,
  deps: {
    neverBundle: [
      /^@deepseek-ai\//,
      /^@larksuiteoapi\//,
      /^@sinclair\//,
      'clawpdf',
      'image-size',
      'undici-types',
      'zod',
      /^node:/,
    ],
  },
});
