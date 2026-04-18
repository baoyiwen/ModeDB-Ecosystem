import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

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
  server: {
    port: 5174,
    fs: { allow: ['..', '../..'] },
  },
  optimizeDeps: {
    include: ['@mode-db/sdk'],
  },
});
