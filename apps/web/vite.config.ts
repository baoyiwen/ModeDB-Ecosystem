import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

// When a dependency resolves to `../../packages/...`, Vite can mis-resolve
// `vite-plugin-node-polyfills/shims/*` relative to the importer (ENOENT under `apps/web/`).
// Map those specifiers to the real package subpath exports.
function resolveNodePolyfillsShimId(source: string): string | undefined {
  if (!source.startsWith('vite-plugin-node-polyfills/shims/')) {
    return undefined;
  }
  try {
    return fileURLToPath(import.meta.resolve(source, import.meta.url));
  } catch {
    return undefined;
  }
}

export default defineConfig({
  plugins: [
    {
      name: 'resolve-node-polyfills-shims',
      enforce: 'pre',
      resolveId(source) {
        return resolveNodePolyfillsShimId(source);
      },
    },
    react(),
    nodePolyfills({
      globals: {
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@mode-db/data-ui': path.resolve(repoRoot, 'packages/data-ui/src/index.ts'),
    },
  },
  server: {
    host: true,
    port: 5174,
    fs: { allow: ['..', '../..'] },
  },
  optimizeDeps: {
    include: ['@mode-db/sdk'],
  },
});
