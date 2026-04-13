import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ['mode-db-engine', 'ws'],
});
