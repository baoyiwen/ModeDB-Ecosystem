/** Explicit frontend build settings: never load local Vite configuration or .env files. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildReleaseApplication({ name, sourceRoot, toolingRoot, output, aliases }) {
  assert.ok(['model-designer', 'data-studio', 'web'].includes(name), 'RELEASE_APP_UNKNOWN');
  assert.ok(!existsSync(output), 'RELEASE_APP_OUTPUT_EXISTS');
  const require = createRequire(join(resolve(toolingRoot), 'package.json'));
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const { default: react } = await import(
    pathToFileURL(require.resolve('@vitejs/plugin-react')).href
  );
  const plugins = [react()];
  if (name === 'web') {
    const { nodePolyfills } = await import(
      pathToFileURL(require.resolve('vite-plugin-node-polyfills')).href
    );
    plugins.unshift({
      name: 'resolve-node-polyfills-shims',
      enforce: 'pre',
      resolveId(source) {
        if (source.startsWith('vite-plugin-node-polyfills/shims/')) {
          return require.resolve(source);
        }
      },
    });
    plugins.push(nodePolyfills({ globals: { process: true } }));
  }
  await build({
    configFile: false,
    envFile: false,
    root: resolve(sourceRoot),
    plugins,
    resolve: { alias: aliases },
    build: { outDir: resolve(output), emptyOutDir: false },
  });
}
