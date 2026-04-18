import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true, // 核心：全局注入 Buffer
        process: true,
      },
    }),
  ],
  server: {
    port: 5174,
    fs: { allow: ['..', '../..'] },
  },
  optimizeDeps: {
    include: ['buffer', '@mode-db/sdk'],
  },
});
