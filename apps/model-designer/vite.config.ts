import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mode-db/data-kit': path.resolve(repoRoot, 'packages/data-kit/src/index.ts'),
      '@mode-db/data-ui': path.resolve(repoRoot, 'packages/data-ui/src/index.ts'),
      '@mode-db/sdk': path.resolve(repoRoot, 'packages/sdk/src/index.ts'),
      '@mode-db/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    https: {
      cert: readFileSync('C:/workspace/web_code/ModeDB-Ecosystem/certs/server.crt'),
      key: readFileSync('C:/workspace/web_code/ModeDB-Ecosystem/certs/server.key'),
    },
  },
});
