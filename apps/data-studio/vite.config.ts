import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mode-db/data-ui': path.resolve(repoRoot, 'packages/data-ui/src/index.ts'),
      '@mode-db/data-kit': path.resolve(repoRoot, 'packages/data-kit/src/index.ts'),
    },
  },
  server: {
    port: 5176,
  },
});
